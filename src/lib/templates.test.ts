import assert from "node:assert/strict";
import { test } from "node:test";

import { degrees, PDFDocument } from "pdf-lib";
import type { QueryResult } from "pg";

import type { DbExecutor } from "./db/connection.ts";
import {
  StorageObjectNotFoundError,
  type StorageService,
} from "./services/storage.ts";
import {
  describeTemplateDropdownProblem,
  describeUnsendableTemplate,
  getTemplateForBulkSend,
  getUseTemplateDataForUser,
  TemplateError,
} from "./templates.ts";

const role = { id: "role-1", name: "Signer" };

function signatureField(signerId = role.id) {
  return {
    height: 0.03,
    page: 1,
    required: true,
    signerId,
    type: "signature",
    width: 0.2,
    x: 0.1,
    y: 0.1,
  };
}

test("a template with no signature field cannot be sent", () => {
  assert.match(
    describeUnsendableTemplate([role], []) ?? "",
    /Add signers and place fields/,
  );
  assert.match(
    describeUnsendableTemplate(
      [role],
      [
        {
          ...signatureField(),
          label: "Note",
          type: "text",
        },
      ],
    ) ?? "",
    /Signature field/,
  );
  assert.equal(describeUnsendableTemplate([role], [signatureField()]), null);
});

test("a dropdown with fewer than two choices cannot be sent", () => {
  assert.match(
    describeUnsendableTemplate(
      [role],
      [
        signatureField(),
        {
          ...signatureField(),
          options: ["Only one"],
          type: "dropdown",
          y: 0.2,
        },
      ],
    ) ?? "",
    /dropdown/,
  );
});

test("approver roles need no Signature field, but someone has to sign", () => {
  const approver = {
    id: "role-2",
    kind: "approver" as const,
    name: "Approver",
  };

  assert.equal(
    describeUnsendableTemplate([role, approver], [signatureField()]),
    null,
  );
  assert.match(
    describeUnsendableTemplate([approver], [signatureField(approver.id)]) ?? "",
    /Add at least one signer/,
  );
  assert.match(
    describeUnsendableTemplate(
      [role, approver],
      [signatureField(), signatureField(approver.id)],
    ) ?? "",
    /approvers have no fields/,
  );
});

const LONG_DROPDOWN_CHOICES = [
  "Approved with the conditions listed in the schedule",
  "Rejected until the landlord answers the open questions",
];

async function makeLetterPdf(rotationDegrees = 0): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);

  if (rotationDegrees !== 0) {
    page.setRotation(degrees(rotationDegrees));
  }

  return pdf.save();
}

function makeMemoryStorage(
  files: Record<string, Uint8Array>,
  onRead?: (key: string) => void,
): StorageService {
  const refuse = async (): Promise<never> => {
    throw new Error("unexpected storage call");
  };

  return {
    deleteObject: refuse,
    async getObject(key) {
      onRead?.(key);
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

function makeTemplateDb(row: {
  fields: unknown;
  id: string;
  name: string;
  pageCount: number;
  roles: unknown;
  sourcePdfFilename: string;
  sourcePdfKey: string;
}): DbExecutor {
  return {
    async query() {
      return {
        command: "",
        fields: [],
        oid: 0,
        rowCount: 1,
        rows: [{ ...row, createdAt: 1_800_000_000 }],
      } as unknown as QueryResult;
    },
  };
}

test("describeTemplateDropdownProblem flags unreadable dropdowns and allows readable ones (issue #223)", async () => {
  const key = "templates/letter.pdf";
  let storageReads = 0;
  const storage = makeMemoryStorage({ [key]: await makeLetterPdf() }, () => {
    storageReads += 1;
  });

  // Templates with no dropdowns never touch storage.
  assert.equal(
    await describeTemplateDropdownProblem(
      [role],
      [signatureField()],
      { filename: "letter.pdf", key },
      storage,
    ),
    null,
  );
  assert.equal(storageReads, 0);

  // Narrow dropdown (5% x 1.2% on Letter) with long choices is rejected.
  const narrowProblem = await describeTemplateDropdownProblem(
    [role],
    [
      signatureField(),
      {
        ...signatureField(),
        height: 0.012,
        options: LONG_DROPDOWN_CHOICES,
        type: "dropdown",
        width: 0.05,
        y: 0.3,
      },
    ],
    { filename: "letter.pdf", key },
    storage,
  );

  assert.match(
    narrowProblem ?? "",
    /A dropdown for Signer on page 1 is too small to show its choices at a readable size/,
  );

  // Wider dropdown control with the same choices passes cleanly.
  const wideProblem = await describeTemplateDropdownProblem(
    [role],
    [
      signatureField(),
      {
        ...signatureField(),
        height: 0.03,
        options: LONG_DROPDOWN_CHOICES,
        type: "dropdown",
        width: 0.6,
        y: 0.3,
      },
    ],
    { filename: "letter.pdf", key },
    storage,
  );

  assert.equal(wideProblem, null);

  // Missing PDF in storage surfaces a 409 TemplateError.
  await assert.rejects(
    describeTemplateDropdownProblem(
      [role],
      [
        signatureField(),
        {
          ...signatureField(),
          options: ["Yes", "No"],
          type: "dropdown",
          y: 0.3,
        },
      ],
      { filename: "missing.pdf", key: "templates/missing.pdf" },
      storage,
    ),
    (error: unknown) =>
      error instanceof TemplateError && error.statusCode === 409,
  );
});

test("describeTemplateDropdownProblem uses displayed page geometry for rotated PDFs (issue #223)", async () => {
  const key = "templates/rotated.pdf";
  const storage = makeMemoryStorage({ [key]: await makeLetterPdf(90) });

  // Rotated 90 degrees: displayed size is 792 x 612. A 5% x 1.2% box is still
  // too small for long choices, while a 60% x 4% box fits cleanly.
  assert.match(
    (await describeTemplateDropdownProblem(
      [role],
      [
        signatureField(),
        {
          ...signatureField(),
          height: 0.012,
          options: LONG_DROPDOWN_CHOICES,
          type: "dropdown",
          width: 0.05,
          y: 0.3,
        },
      ],
      { filename: "rotated.pdf", key },
      storage,
    )) ?? "",
    /too small to show its choices at a readable size/,
  );

  assert.equal(
    await describeTemplateDropdownProblem(
      [role],
      [
        signatureField(),
        {
          ...signatureField(),
          height: 0.04,
          options: LONG_DROPDOWN_CHOICES,
          type: "dropdown",
          width: 0.6,
          y: 0.3,
        },
      ],
      { filename: "rotated.pdf", key },
      storage,
    ),
    null,
  );
});

test("getTemplateForBulkSend rejects unreadable dropdowns while getUseTemplateDataForUser still opens the template (issue #223)", async () => {
  const key = "templates/narrow.pdf";
  const storage = makeMemoryStorage({ [key]: await makeLetterPdf() });
  const db = makeTemplateDb({
    fields: [
      signatureField(),
      {
        ...signatureField(),
        height: 0.012,
        options: LONG_DROPDOWN_CHOICES,
        type: "dropdown",
        width: 0.05,
        y: 0.3,
      },
    ],
    id: "tpl-1",
    name: "Narrow dropdown template",
    pageCount: 1,
    roles: [role],
    sourcePdfFilename: "narrow.pdf",
    sourcePdfKey: key,
  });

  await assert.rejects(
    getTemplateForBulkSend("user-1", "tpl-1", db, { storageService: storage }),
    (error: unknown) =>
      error instanceof TemplateError &&
      error.statusCode === 400 &&
      /dropdown for Signer on page 1 is too small/.test(error.message),
  );

  // Use template creates an editable draft, so it must still load.
  const useData = await getUseTemplateDataForUser("user-1", "tpl-1", db);

  assert.equal(useData?.id, "tpl-1");
  assert.equal(useData?.name, "Narrow dropdown template");
});
