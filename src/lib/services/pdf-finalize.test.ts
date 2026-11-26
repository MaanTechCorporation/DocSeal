import assert from "node:assert/strict";
import test from "node:test";

import { PDFDocument } from "pdf-lib";

import type { AuditEventRecord, EnvelopeRecord } from "../schemas/envelope.ts";
import type { FieldRecord } from "../schemas/field.ts";
import type { SignerRecord } from "../schemas/signer.ts";
import {
  computeAuditFingerprint,
  describeAuditActor,
  findTypedValueTooLongForField,
  renderEnvelopeCertificatePdf,
  renderFinalizedEnvelopePdf,
  wrapFieldText,
} from "./pdf-finalize.ts";
import { embedTextFaces } from "./pdf-fonts.ts";
import { sha256Hex } from "./pdf-seal.ts";
import type { StorageService } from "./storage.ts";

// Names and values outside Windows-1252 used to fail the whole signing with
// "WinAnsi cannot encode". These tests run the two renderers on such text.

const TITLE = "Umowa o dzieło – Łódź / 業務委託契約書";
const SIGNER_NAME = "Łukasz Żółć";
const SECOND_SIGNER_NAME = "山田 太郎";
const TEXT_VALUE = "Санкт-Петербург, 東京都";

async function extractText(pdfBytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const parts: string[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();

    parts.push(
      content.items.map((item: { str?: string }) => item.str ?? "").join(" "),
    );
  }

  await document.destroy();

  return parts.join("\n");
}

async function makeFixture() {
  const sourceDocument = await PDFDocument.create();

  sourceDocument.addPage([612, 792]);

  const sourcePdf = await sourceDocument.save();
  const now = 1_800_000_000;
  const envelope: EnvelopeRecord = {
    completedAt: now,
    createdAt: now - 500,
    declinedAt: null,
    evidenceKey: null,
    id: "envelope-1",
    pageCount: 1,
    sentAt: now - 400,
    signedPdfKey: null,
    sourcePdfFilename: "umowa.pdf",
    sourcePdfHash: sha256Hex(sourcePdf),
    sourcePdfKey: "source.pdf",
    sourcePdfSizeBytes: sourcePdf.byteLength,
    status: "completed",
    title: TITLE,
    updatedAt: now,
    userId: "user-1",
    voidedAt: null,
  };
  const signers: SignerRecord[] = [
    {
      createdAt: now - 500,
      email: "lukasz@example.com",
      id: "signer-1",
      name: SIGNER_NAME,
      signedAt: now - 100,
      signOrder: 1,
      status: "signed",
      updatedAt: now - 100,
    },
    {
      createdAt: now - 500,
      email: "yamada@example.com",
      id: "signer-2",
      name: SECOND_SIGNER_NAME,
      signedAt: now,
      signOrder: 2,
      status: "signed",
      updatedAt: now,
    },
  ];
  const baseField = {
    createdAt: now - 500,
    envelopeId: envelope.id,
    height: 0.05,
    page: 1,
    required: true,
    submittedAt: now - 100,
    updatedAt: now - 100,
    width: 0.4,
    x: 0.1,
  };
  const fields: FieldRecord[] = [
    {
      ...baseField,
      id: "field-1",
      inputMethod: "typed",
      signerId: "signer-1",
      type: "signature",
      value: SIGNER_NAME,
      y: 0.1,
    },
    {
      ...baseField,
      id: "field-2",
      inputMethod: "typed",
      signerId: "signer-2",
      type: "signature",
      value: SECOND_SIGNER_NAME,
      y: 0.2,
    },
    {
      ...baseField,
      id: "field-3",
      signerId: "signer-1",
      type: "text",
      value: TEXT_VALUE,
      y: 0.3,
    },
    {
      ...baseField,
      id: "field-4",
      signerId: "signer-1",
      type: "text",
      value: "first line\nsecond line",
      y: 0.4,
    },
  ];
  const auditEvents: AuditEventRecord[] = [
    {
      actorEmail: "lukasz@example.com",
      actorType: "signer",
      createdAt: now - 100,
      envelopeId: envelope.id,
      event: "signed",
      id: "event-1",
      ipAddress: "203.0.113.7",
      metadata: {
        signerEmail: "lukasz@example.com",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
      userAgent: "Mozilla/5.0 (テスト)",
    },
  ];
  const storageService = {
    getObject: async () => ({
      body: sourcePdf,
      contentLength: sourcePdf.byteLength,
      contentType: "application/pdf",
    }),
  } as unknown as StorageService;

  return { auditEvents, envelope, fields, signers, storageService };
}

const saveUnsealed = (pdfDocument: PDFDocument) => pdfDocument.save();

test("the signed PDF stamps values in any of the supported scripts", async () => {
  const fixture = await makeFixture();
  const pdfBytes = await renderFinalizedEnvelopePdf(
    {
      auditEvents: fixture.auditEvents,
      completedAt: fixture.envelope.completedAt!,
      envelope: fixture.envelope,
      fields: fixture.fields,
      signers: fixture.signers,
      pages: [],
      sourcePdfKey: fixture.envelope.sourcePdfKey,
    },
    { seal: saveUnsealed, storageService: fixture.storageService },
  );
  const text = (await extractText(pdfBytes)).replace(/\s+/g, " ");

  assert.ok(text.includes(SIGNER_NAME));
  assert.ok(text.includes(SECOND_SIGNER_NAME));
  assert.ok(text.includes(TEXT_VALUE));
  // A line break in a value used to fail too. It is drawn as a space.
  assert.ok(text.includes("first line second line"));
  // Only the glyphs in use are embedded, next to the script font.
  assert.ok(
    pdfBytes.byteLength < 500_000,
    `signed PDF is ${String(pdfBytes.byteLength)} bytes`,
  );
});

test("the certificate prints names, titles and browser strings as they are", async () => {
  const fixture = await makeFixture();
  const pdfBytes = await renderEnvelopeCertificatePdf(
    {
      auditEvents: fixture.auditEvents,
      envelope: fixture.envelope,
      signers: fixture.signers,
    },
    { seal: saveUnsealed },
  );
  const text = (await extractText(pdfBytes)).replace(/\s+/g, " ");

  assert.ok(text.includes("Łódź"));
  assert.ok(text.includes("業務委託契約書"));
  assert.ok(text.includes(SIGNER_NAME));
  assert.ok(text.includes(SECOND_SIGNER_NAME));
  assert.ok(text.includes("テスト"));
  assert.ok(
    pdfBytes.byteLength < 200_000,
    `certificate is ${String(pdfBytes.byteLength)} bytes`,
  );

  const reloaded = await PDFDocument.load(pdfBytes);

  assert.ok(reloaded.getTitle()?.includes("業務委託契約書"));
});

test("the certificate names the people who were sent a copy", async () => {
  const fixture = await makeFixture();
  const copyRecipients = [
    { email: "zofia@example.com", name: "Zofia Wiśniewska" },
  ];
  const render = (redactForRecipients: boolean) =>
    renderEnvelopeCertificatePdf(
      {
        auditEvents: fixture.auditEvents,
        copyRecipients,
        envelope: fixture.envelope,
        redactForRecipients,
        signers: fixture.signers,
      },
      { seal: saveUnsealed },
    ).then(async (bytes) => (await extractText(bytes)).replace(/\s+/g, " "));
  const full = await render(false);

  assert.ok(full.includes("Copy recipients"));
  assert.ok(full.includes("They did not sign it."));
  assert.ok(full.includes("Zofia Wiśniewska <zofia@example.com>"));

  // The signers' own copy leaves addresses out, as it does for signers.
  const redacted = await render(true);

  assert.ok(redacted.includes("Zofia Wiśniewska"));
  assert.ok(!redacted.includes("zofia@example.com"));

  // No section at all when nobody was sent a copy.
  const without = await renderEnvelopeCertificatePdf(
    {
      auditEvents: fixture.auditEvents,
      envelope: fixture.envelope,
      signers: fixture.signers,
    },
    { seal: saveUnsealed },
  );

  assert.ok(!(await extractText(without)).includes("Copy recipients"));
});

test("recipient certificates omit a correction's previous email", async () => {
  const fixture = await makeFixture();
  const previousEmail = "previous.signer@hide.test";
  const auditEvents: AuditEventRecord[] = [
    {
      actorEmail: "sam@example.test",
      actorType: "sender",
      createdAt: 1_800_000_000 - 50,
      envelopeId: fixture.envelope.id,
      event: "signer_corrected",
      id: "event-correction",
      metadata: {
        previousEmail,
        previousName: SIGNER_NAME,
        signerEmail: "lukasz@example.com",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
    },
    ...fixture.auditEvents,
  ];
  const render = (redactForRecipients: boolean) =>
    renderEnvelopeCertificatePdf(
      {
        auditEvents,
        envelope: fixture.envelope,
        redactForRecipients,
        signers: fixture.signers,
      },
      { seal: saveUnsealed },
    ).then(async (bytes) => (await extractText(bytes)).replace(/\s+/g, " "));
  const full = await render(false);
  const redacted = await render(true);

  assert.ok(full.includes(previousEmail));
  assert.ok(full.includes("Signer email corrected from"));
  assert.ok(!redacted.includes(previousEmail));
  assert.ok(redacted.includes("Signer email was corrected"));
});

test("the certificate credits consent recorded after a signer correction", async () => {
  const fixture = await makeFixture();
  const auditEvents: AuditEventRecord[] = [
    {
      actorEmail: "old@example.com",
      actorType: "signer",
      createdAt: 1_799_999_000,
      envelopeId: fixture.envelope.id,
      event: "consented",
      id: "event-old-consent",
      metadata: {
        disclosureVersion: "old-version",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
    },
    {
      actorEmail: "sam@example.test",
      actorType: "sender",
      createdAt: 1_799_999_010,
      envelopeId: fixture.envelope.id,
      event: "signer_corrected",
      id: "event-correction",
      metadata: {
        previousEmail: "old@example.com",
        previousName: SIGNER_NAME,
        signerEmail: "lukasz@example.com",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
    },
    {
      actorEmail: "lukasz@example.com",
      actorType: "signer",
      createdAt: 1_800_000_050,
      envelopeId: fixture.envelope.id,
      event: "consented",
      id: "event-new-consent",
      metadata: {
        disclosureVersion: "new-version",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
    },
    ...fixture.auditEvents,
  ];
  const text = (
    await extractText(
      await renderEnvelopeCertificatePdf(
        {
          auditEvents,
          envelope: fixture.envelope,
          signers: fixture.signers,
        },
        { seal: saveUnsealed },
      ),
    )
  ).replace(/\s+/g, " ");
  const signersSection = text.split("Audit events")[0] ?? "";

  assert.ok(signersSection.includes("disclosure new-version"));
  assert.ok(!signersSection.includes("disclosure old-version"));
});

test("the certificate keeps restored consent after a reversed correction", async () => {
  const fixture = await makeFixture();
  const auditEvents: AuditEventRecord[] = [
    {
      actorEmail: "lukasz@example.com",
      actorType: "signer",
      createdAt: 1_799_999_000,
      envelopeId: fixture.envelope.id,
      event: "consented",
      id: "event-kept-consent",
      metadata: {
        disclosureVersion: "kept-version",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
    },
    {
      actorEmail: "sam@example.test",
      actorType: "sender",
      createdAt: 1_799_999_010,
      envelopeId: fixture.envelope.id,
      event: "signer_corrected",
      id: "event-correction",
      metadata: {
        previousEmail: "lukasz@example.com",
        previousName: SIGNER_NAME,
        signerEmail: "temporary@example.com",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
    },
    {
      actorEmail: "sam@example.test",
      actorType: "sender",
      createdAt: 1_799_999_020,
      envelopeId: fixture.envelope.id,
      event: "signer_corrected",
      id: "event-reversal",
      metadata: {
        previousEmail: "temporary@example.com",
        previousName: SIGNER_NAME,
        reverted: true,
        signerEmail: "lukasz@example.com",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
    },
    ...fixture.auditEvents,
  ];
  const text = (
    await extractText(
      await renderEnvelopeCertificatePdf(
        {
          auditEvents,
          envelope: fixture.envelope,
          signers: fixture.signers,
        },
        { seal: saveUnsealed },
      ),
    )
  ).replace(/\s+/g, " ");
  const signersSection = text.split("Audit events")[0] ?? "";

  assert.ok(signersSection.includes("disclosure kept-version"));
});

test("numbers and dropdown choices are stamped as text, radio buttons as rings", async () => {
  const fixture = await makeFixture();
  const base = {
    createdAt: 1_800_000_000,
    envelopeId: fixture.envelope.id,
    height: 0.03,
    page: 1,
    required: true,
    signerId: "signer-1",
    submittedAt: 1_800_000_000,
    updatedAt: 1_800_000_000,
    width: 0.3,
    x: 0.1,
  };
  const choiceFields: FieldRecord[] = [
    { ...base, id: "number-1", type: "number", value: "1,250.75", y: 0.5 },
    {
      ...base,
      id: "dropdown-1",
      options: ["Tak", "Nie", "Nie wiem"],
      type: "dropdown",
      value: "Nie wiem",
      y: 0.55,
    },
    // An optional dropdown that was left alone: nothing to stamp.
    {
      ...base,
      id: "dropdown-2",
      options: ["One", "Two"],
      required: false,
      submittedAt: null,
      type: "dropdown",
      value: null,
      y: 0.6,
    },
    {
      ...base,
      checked: true,
      groupId: "group-1",
      id: "radio-1",
      label: "Yes",
      type: "radio",
      width: 0.03,
      y: 0.65,
    },
    {
      ...base,
      checked: false,
      groupId: "group-1",
      id: "radio-2",
      label: "No",
      type: "radio",
      width: 0.03,
      y: 0.7,
    },
  ];
  const render = (fields: FieldRecord[]) =>
    renderFinalizedEnvelopePdf(
      {
        auditEvents: fixture.auditEvents,
        completedAt: fixture.envelope.completedAt!,
        envelope: fixture.envelope,
        fields,
        signers: fixture.signers,
        pages: [],
        sourcePdfKey: fixture.envelope.sourcePdfKey,
      },
      { seal: saveUnsealed, storageService: fixture.storageService },
    );
  const pdfBytes = await render([...fixture.fields, ...choiceFields]);
  const text = (await extractText(pdfBytes)).replace(/\s+/g, " ");

  assert.ok(text.includes("1,250.75"));
  assert.ok(text.includes("Nie wiem"));
  // The choices that were not picked are not on the document.
  assert.ok(!text.includes("Tak"));
  assert.ok(!text.includes("One"));

  // The two radio buttons add drawing to the page: two rings and one dot.
  // Without them the same document is smaller.
  const withoutRadios = await render([
    ...fixture.fields,
    ...choiceFields.filter((field) => field.type !== "radio"),
  ]);
  const chosenOnly = await render([
    ...fixture.fields,
    ...choiceFields.filter((field) => field.id !== "radio-2"),
  ]);

  assert.ok(pdfBytes.byteLength > chosenOnly.byteLength);
  assert.ok(chosenOnly.byteLength > withoutRadios.byteLength);
});

test("a name field is stamped with the name it was filled in with", async () => {
  const fixture = await makeFixture();
  // Not the name on the fixture's signatures, so only the name field can
  // put it on the page.
  const printedName = "Zofia Nowak-Wiśniewska";
  const nameField: FieldRecord = {
    createdAt: 1_800_000_000,
    envelopeId: fixture.envelope.id,
    height: 0.03,
    id: "name-1",
    inputMethod: "auto",
    page: 1,
    required: true,
    signerId: "signer-1",
    submittedAt: 1_800_000_000,
    type: "name",
    updatedAt: 1_800_000_000,
    value: printedName,
    width: 0.3,
    x: 0.1,
    y: 0.5,
  };
  const pdfBytes = await renderFinalizedEnvelopePdf(
    {
      auditEvents: fixture.auditEvents,
      completedAt: fixture.envelope.completedAt!,
      envelope: fixture.envelope,
      fields: [...fixture.fields, nameField],
      signers: fixture.signers,
      pages: [],
      sourcePdfKey: fixture.envelope.sourcePdfKey,
    },
    { seal: saveUnsealed, storageService: fixture.storageService },
  );
  const text = (await extractText(pdfBytes)).replace(/\s+/g, " ");

  assert.ok(text.includes(printedName));
});

test("a sent row names the sender, not the first signer (issue #52)", async () => {
  const fixture = await makeFixture();
  const auditEvents: AuditEventRecord[] = [
    {
      actorEmail: "sam@sender.example",
      actorType: "sender",
      createdAt: 1_799_999_000,
      envelopeId: fixture.envelope.id,
      event: "sent",
      id: "event-sent",
      metadata: {
        signerEmail: "lukasz@example.com",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
    },
    {
      actorType: "system",
      createdAt: 1_799_999_100,
      envelopeId: fixture.envelope.id,
      event: "reminded_auto",
      id: "event-reminded",
      metadata: {
        signerEmail: "lukasz@example.com",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
    },
    {
      actorEmail: "lukasz@example.com",
      actorType: "signer",
      createdAt: 1_799_999_200,
      envelopeId: fixture.envelope.id,
      event: "viewed",
      id: "event-viewed",
      metadata: { signerId: "signer-1", signerName: SIGNER_NAME },
    },
  ];
  const render = async (redactForRecipients: boolean) =>
    (
      await extractText(
        await renderEnvelopeCertificatePdf(
          {
            auditEvents,
            envelope: fixture.envelope,
            redactForRecipients,
            signers: fixture.signers,
          },
          { seal: saveUnsealed },
        ),
      )
    ).replace(/\s+/g, " ");

  for (const redacted of [false, true]) {
    const text = await render(redacted);

    assert.ok(!text.includes(`${SIGNER_NAME} <sam@sender.example>`), text);
    assert.match(text, /sent \| sam@sender\.example/);
    assert.match(text, /reminded_auto \| system/);
    assert.ok(
      text.includes(
        `viewed | ${SIGNER_NAME} <${redacted ? "signer" : "lukasz@example.com"}>`,
      ),
      text,
    );
  }
});

test("describeAuditActor keeps the signer's name on the signer's own rows", () => {
  const base = {
    createdAt: 1,
    envelopeId: "envelope-1",
    id: "event-1",
  } as const;

  assert.equal(
    describeAuditActor({
      ...base,
      actorEmail: "sam@sender.example",
      actorType: "sender",
      event: "reminded_manual",
      metadata: { signerEmail: "p@example.com", signerName: "Priya Patel" },
    }),
    "sam@sender.example",
  );
  assert.equal(
    describeAuditActor({
      ...base,
      actorEmail: "p@example.com",
      actorType: "signer",
      event: "signed",
      metadata: { signerName: "Priya Patel" },
    }),
    "Priya Patel <p@example.com>",
  );
  assert.equal(
    describeAuditActor({
      ...base,
      actorType: "system",
      event: "expired",
      metadata: { signerEmail: "p@example.com", signerName: "Priya Patel" },
    }),
    "system",
  );
});

// A Text field in the place and size from issue #90: right of centre on a
// US Letter page, 19% of the page wide and 6% high.
const NARROW_FIELD = { height: 0.06, page: 1, width: 0.19, x: 0.69, y: 0.32 };
const LETTER_PAGE = { heightPt: 792, pageNumber: 1, widthPt: 612 };

async function extractTextItems(pdfBytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const page = await document.getPage(1);
  const content = await page.getTextContent();
  const items = (
    content.items as Array<{
      height?: number;
      str?: string;
      transform?: number[];
      width?: number;
    }>
  )
    .filter((item) => item.str && item.transform)
    .map((item) => ({
      height: item.height ?? 0,
      left: item.transform![4]!,
      right: item.transform![4]! + (item.width ?? 0),
      text: item.str!,
      y: item.transform![5]!,
    }));

  await document.destroy();

  return items;
}

async function renderOneTextField(value: string) {
  const fixture = await makeFixture();
  const field: FieldRecord = {
    ...NARROW_FIELD,
    createdAt: 1_800_000_000,
    envelopeId: fixture.envelope.id,
    id: "long-text",
    required: true,
    signerId: "signer-1",
    submittedAt: 1_800_000_000,
    type: "text",
    updatedAt: 1_800_000_000,
    value,
  };

  return renderFinalizedEnvelopePdf(
    {
      auditEvents: fixture.auditEvents,
      completedAt: fixture.envelope.completedAt!,
      envelope: fixture.envelope,
      fields: [field],
      pages: [LETTER_PAGE],
      signers: fixture.signers,
      sourcePdfKey: fixture.envelope.sourcePdfKey,
    },
    { seal: saveUnsealed, storageService: fixture.storageService },
  );
}

const LONG_ANSWER = [
  "BEGIN",
  "The tenant agrees to keep the garden tidy, to water the plants",
  "twice a week in summer, and to tell the landlord about any leak",
  "within two days of finding it.",
  "FINISH-MARKER",
].join(" ");

test("a long text answer wraps inside its box and is kept whole", async () => {
  const items = await extractTextItems(await renderOneTextField(LONG_ANSWER));
  const fieldLeft = NARROW_FIELD.x * 612;
  const fieldRight = (NARROW_FIELD.x + NARROW_FIELD.width) * 612;
  const fieldTop = 792 - NARROW_FIELD.y * 792;
  const fieldBottom = fieldTop - NARROW_FIELD.height * 792;
  const joined = items
    .map((item) => item.text)
    .join(" ")
    .replace(/\s+/g, " ");

  assert.ok(joined.includes("BEGIN"));
  assert.ok(joined.includes("FINISH-MARKER"));
  assert.ok(new Set(items.map((item) => Math.round(item.y))).size > 1);

  for (const item of items) {
    assert.ok(item.left >= fieldLeft, `${item.text} starts left of its box`);
    assert.ok(item.right <= fieldRight + 0.5, `${item.text} runs past its box`);
    assert.ok(item.y >= fieldBottom && item.y <= fieldTop);
  }
});

test("a short text answer is still drawn on one line", async () => {
  const items = await extractTextItems(await renderOneTextField("Approved"));

  assert.deepEqual(
    items.map((item) => item.text),
    ["Approved"],
  );
});

const ISSUE_90_ANSWER = `BEGIN ${"W".repeat(240)} FINISH-MARKER`;

test("an answer already accepted that is too long is drawn whole, not cut off", async () => {
  const items = await extractTextItems(
    await renderOneTextField(ISSUE_90_ANSWER),
  );
  const joined = items.map((item) => item.text).join("");

  assert.ok(joined.includes("FINISH-MARKER"));
  assert.equal(joined.replace(/[^W]/g, "").length, 240);

  for (const item of items) {
    assert.ok(item.right <= 612, `${item.text} runs off the page`);
  }
});

test("signing is told when an answer cannot fit its box at a readable size", async () => {
  const field = { ...NARROW_FIELD };

  assert.equal(
    await findTypedValueTooLongForField(
      [{ field, value: LONG_ANSWER }],
      [LETTER_PAGE],
    ),
    null,
  );

  const tooLong = await findTypedValueTooLongForField(
    [
      { field, value: "Approved" },
      { field, value: ISSUE_90_ANSWER },
    ],
    [LETTER_PAGE],
  );

  assert.ok(tooLong);
  assert.equal(tooLong.page, 1);
  assert.ok(tooLong.maxCharacters > 0);
  assert.ok(tooLong.maxCharacters < ISSUE_90_ANSWER.length);

  // The length it names does fit.
  assert.equal(
    await findTypedValueTooLongForField(
      [
        {
          field,
          value: Array.from(ISSUE_90_ANSWER)
            .slice(0, tooLong.maxCharacters)
            .join(""),
        },
      ],
      [LETTER_PAGE],
    ),
    null,
  );
});

test("a box shorter than two readable lines takes only one", async () => {
  // 3.6 pt high: one line at the readable size, as before, but no second.
  const field = { ...NARROW_FIELD, height: 0.0045 };

  assert.equal(
    await findTypedValueTooLongForField(
      [{ field, value: "Approved" }],
      [LETTER_PAGE],
    ),
    null,
  );
  assert.ok(
    await findTypedValueTooLongForField(
      [{ field, value: LONG_ANSWER }],
      [LETTER_PAGE],
    ),
  );
});

test("spaces inside an answer are kept as they were typed", async () => {
  const faces = await embedTextFaces(await PDFDocument.create(), [
    "AB  12 and more words",
  ]);

  // pdf.js merges runs of spaces when it extracts text, so the lines are
  // checked as they are laid out.
  assert.deepEqual(wrapFieldText(faces.regular, 10, 500, "AB  12"), ["AB  12"]);
  assert.deepEqual(
    wrapFieldText(faces.regular, 10, 60, "AB  12 and more words"),
    ["AB  12 and", "more words"],
  );
});

// Audit rows print "time | event | actor". Returns the events in the order
// the certificate lists them.
function certificateEventOrder(text: string): string[] {
  return [...text.matchAll(/UTC \| ([a-z_]+) \|/g)].map((match) => match[1]);
}

async function renderCertificateText(
  envelope: EnvelopeRecord,
  signers: SignerRecord[],
  auditEvents: AuditEventRecord[],
): Promise<string> {
  return (
    await extractText(
      await renderEnvelopeCertificatePdf(
        { auditEvents, envelope, signers },
        { seal: saveUnsealed },
      ),
    )
  ).replace(/\s+/g, " ");
}

test("the last signature is listed before completed in the same second (issue #97)", async () => {
  const fixture = await makeFixture();
  const now = fixture.envelope.completedAt ?? 0;
  // The ids sort after any generated id, so a sort by time then id would
  // put the completed row first.
  const auditEvents: AuditEventRecord[] = [
    {
      actorEmail: "yamada@example.com",
      actorType: "signer",
      createdAt: now,
      envelopeId: fixture.envelope.id,
      event: "signed",
      id: "zz-event-signed",
      metadata: { signerId: "signer-2", signerName: SECOND_SIGNER_NAME },
    },
  ];
  const text = await renderCertificateText(
    fixture.envelope,
    fixture.signers,
    auditEvents,
  );

  assert.deepEqual(certificateEventOrder(text), ["signed", "completed"], text);
});

test("a recorded completed row keeps its place in the recorded order (issue #97)", async () => {
  const fixture = await makeFixture();
  const now = fixture.envelope.completedAt ?? 0;
  const auditEvents: AuditEventRecord[] = [
    {
      actorEmail: "yamada@example.com",
      actorType: "signer",
      createdAt: now,
      envelopeId: fixture.envelope.id,
      event: "signed",
      id: "zz-event-signed",
      metadata: { signerId: "signer-2", signerName: SECOND_SIGNER_NAME },
    },
    {
      actorType: "system",
      createdAt: now,
      envelopeId: fixture.envelope.id,
      event: "completed",
      id: "aa-event-completed",
      metadata: null,
    },
    {
      actorType: "system",
      createdAt: now,
      envelopeId: fixture.envelope.id,
      event: "email_sent",
      id: "00-event-email",
      metadata: null,
    },
  ];
  const text = await renderCertificateText(
    fixture.envelope,
    fixture.signers,
    auditEvents,
  );

  assert.deepEqual(
    certificateEventOrder(text),
    ["signed", "completed", "email_sent"],
    text,
  );
});

test("declined and voided certificates keep same-second events in recorded order (issue #97)", async () => {
  const fixture = await makeFixture();
  const at = 1_799_999_000;
  const sameSecond = (
    event: AuditEventRecord["event"],
    id: string,
  ): AuditEventRecord => ({
    actorType: "system",
    createdAt: at,
    envelopeId: fixture.envelope.id,
    event,
    id,
    metadata: null,
  });

  for (const [status, terminalEvent] of [
    ["declined", "declined"],
    ["voided", "voided"],
  ] as const) {
    const envelope: EnvelopeRecord = {
      ...fixture.envelope,
      completedAt: null,
      declinedAt: status === "declined" ? at : null,
      status,
      voidedAt: status === "voided" ? at : null,
    };
    // Recorded order: sent, signed, the next invitation, then the end. The
    // ids are in reverse, so a sort by id would turn them around.
    const auditEvents = [
      sameSecond("sent", "d-sent"),
      sameSecond("signed", "c-signed"),
      sameSecond("email_sent", "b-email"),
      sameSecond(terminalEvent, "a-end"),
    ];
    const text = await renderCertificateText(
      envelope,
      fixture.signers,
      auditEvents,
    );

    assert.deepEqual(
      certificateEventOrder(text),
      ["sent", "signed", "email_sent", terminalEvent],
      text,
    );
  }
});

test("a captured email is not described as accepted by a mail provider (issue #106)", async () => {
  const fixture = await makeFixture();
  const emailSent = (id: string, messageId: string): AuditEventRecord => ({
    actorType: "system",
    createdAt: 1_799_999_000,
    envelopeId: fixture.envelope.id,
    event: "email_sent",
    id,
    metadata: {
      messageId,
      recipient: "lukasz@example.com",
      signerId: "signer-1",
      template: "signing_invitation",
    },
  });
  const auditEvents = [
    emailSent("event-captured", "capture-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"),
    emailSent("event-provider", "4ef9a417-02e9-4d39-ad75-9611e0fcc33c"),
  ];
  const text = (
    await extractText(
      await renderEnvelopeCertificatePdf(
        {
          auditEvents,
          envelope: fixture.envelope,
          redactForRecipients: false,
          signers: fixture.signers,
        },
        { seal: saveUnsealed },
      ),
    )
  ).replace(/\s+/g, " ");

  assert.ok(
    text.includes(
      "captured locally as capture-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed, not sent",
    ),
    text,
  );
  assert.ok(
    !text.includes(
      "accepted by the mail provider as capture-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
    ),
    text,
  );
  assert.ok(
    text.includes(
      "accepted by the mail provider as 4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
    ),
    text,
  );
});

test("the new wording leaves the audit fingerprint of a captured email unchanged (issue #106)", () => {
  // Certificates sealed before the fix printed this fingerprint for the same
  // row, so they still match the stored audit trail.
  assert.equal(
    computeAuditFingerprint([
      {
        actorType: "system",
        createdAt: 1_799_999_000,
        envelopeId: "env",
        event: "email_sent",
        id: "event-captured",
        metadata: {
          messageId: "capture-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
          recipient: "lukasz@example.com",
          signerId: "signer-1",
          template: "signing_invitation",
        },
      },
    ]),
    "876cbd8661559c69681db5458f3baf2f8e1c8ccc4c43c9352691608e68b61c32",
  );
});

type ExtractedTextItem = Awaited<ReturnType<typeof extractTextItems>>[number];

function itemBoxesOverlap2D(
  left: ExtractedTextItem,
  right: ExtractedTextItem,
): boolean {
  const leftBottom = left.y;
  const leftTop = left.y + left.height;
  const rightBottom = right.y;
  const rightTop = right.y + right.height;

  return (
    left.left < right.right &&
    left.right > right.left &&
    leftBottom < rightTop &&
    leftTop > rightBottom
  );
}

function assertItemInsideLetterPage(item: ExtractedTextItem) {
  assert.ok(
    item.left >= 0,
    `"${item.text}" starts left of page (${item.left})`,
  );
  assert.ok(
    item.right <= LETTER_PAGE.widthPt,
    `"${item.text}" runs past right edge (${item.right})`,
  );
  assert.ok(item.y >= 0, `"${item.text}" sits below bottom edge (${item.y})`);
  assert.ok(
    item.y + item.height <= LETTER_PAGE.heightPt,
    `"${item.text}" runs past top edge (${item.y + item.height})`,
  );
}

function assertNoPairwiseOverlap(
  groups: ReadonlyArray<{ items: readonly ExtractedTextItem[]; label: string }>,
) {
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      for (const left of groups[i]!.items) {
        for (const right of groups[j]!.items) {
          assert.equal(
            itemBoxesOverlap2D(left, right),
            false,
            `${groups[i]!.label} ("${left.text}" [${left.left.toFixed(2)}..${left.right.toFixed(2)}, ${left.y.toFixed(2)}..${(left.y + left.height).toFixed(2)}]) overlaps ${groups[j]!.label} ("${right.text}" [${right.left.toFixed(2)}..${right.right.toFixed(2)}, ${right.y.toFixed(2)}..${(right.y + right.height).toFixed(2)}])`,
          );
        }
      }
    }
  }
}

async function renderPart11Scenario(input: {
  extraFields?: FieldRecord[];
  signatures: Array<{
    height?: number;
    id: string;
    meaning: "approval" | "authorship" | "responsibility" | "review";
    name: string;
    signedAt?: number;
    width?: number;
    x: number;
    y: number;
  }>;
}) {
  const fixture = await makeFixture();
  const signedAt = Date.UTC(2026, 10, 22, 14, 30, 0) / 1000;
  const envelope: EnvelopeRecord = {
    ...fixture.envelope,
    completedAt: signedAt,
    part11: true,
  };
  const signers: SignerRecord[] = input.signatures.map((entry, index) => ({
    createdAt: signedAt - 500,
    email: `signer-${String(index + 1)}@example.com`,
    id: `part11-signer-${String(index + 1)}`,
    name: entry.name,
    signatureMeaning: entry.meaning,
    signedAt: entry.signedAt ?? signedAt,
    signOrder: index + 1,
    status: "signed",
    updatedAt: entry.signedAt ?? signedAt,
  }));
  const signatureFields: FieldRecord[] = input.signatures.map(
    (entry, index) => ({
      createdAt: signedAt - 500,
      envelopeId: envelope.id,
      height: entry.height ?? 0.07,
      id: entry.id,
      inputMethod: "typed",
      page: 1,
      required: true,
      signerId: `part11-signer-${String(index + 1)}`,
      submittedAt: entry.signedAt ?? signedAt,
      type: "signature",
      updatedAt: entry.signedAt ?? signedAt,
      value: entry.name,
      width: entry.width ?? 0.24,
      x: entry.x,
      y: entry.y,
    }),
  );
  const pdfBytes = await renderFinalizedEnvelopePdf(
    {
      auditEvents: fixture.auditEvents,
      completedAt: signedAt,
      envelope,
      fields: [...signatureFields, ...(input.extraFields ?? [])],
      pages: [LETTER_PAGE],
      signers,
      sourcePdfKey: envelope.sourcePdfKey,
    },
    { seal: saveUnsealed, storageService: fixture.storageService },
  );

  return (await extractTextItems(pdfBytes)).filter(
    (item) => item.text.trim().length > 0,
  );
}

test("side-by-side Part 11 signature manifestations do not overlap (issue #220)", async () => {
  const alice = "Alice Alexander Example-Smythe";
  const bob = "Bob Bartholomew Example-Jones";

  for (const reverseOrder of [false, true]) {
    const signatures = [
      {
        id: "sig-alice",
        meaning: "approval" as const,
        name: alice,
        width: 0.24,
        x: 0.1,
        y: 0.5,
      },
      {
        id: "sig-bob",
        meaning: "review" as const,
        name: bob,
        width: 0.24,
        x: 0.4,
        y: 0.5,
      },
    ];
    const items = await renderPart11Scenario({
      signatures: reverseOrder ? [...signatures].reverse() : signatures,
    });
    // Typed signature values sit at ~11-12 pt; manifestations are drawn at <= 6.5 pt.
    const manifestationItems = items.filter((item) => item.height <= 7);
    const signatureItems = items.filter((item) => item.height > 7);
    const aliceManifestation = manifestationItems.filter(
      (item) => item.left < 0.4 * LETTER_PAGE.widthPt - 1,
    );
    const bobManifestation = manifestationItems.filter(
      (item) => item.left >= 0.4 * LETTER_PAGE.widthPt - 1,
    );

    assert.ok(aliceManifestation.length >= 2);
    assert.ok(bobManifestation.length >= 1);

    for (const item of manifestationItems) {
      assertItemInsideLetterPage(item);
      assert.ok(
        item.height >= 5,
        `"${item.text}" shrunk below readable size (${item.height})`,
      );
    }

    assertNoPairwiseOverlap([
      { items: aliceManifestation, label: "Alice manifestation" },
      { items: bobManifestation, label: "Bob manifestation" },
      { items: signatureItems, label: "Signature values" },
    ]);

    const aliceText = aliceManifestation
      .map((item) => item.text)
      .join(" ")
      .replace(/\s+/g, " ");
    const bobText = bobManifestation
      .map((item) => item.text)
      .join(" ")
      .replace(/\s+/g, " ");

    assert.ok(aliceText.includes(`Signed by ${alice}`), aliceText);
    assert.ok(aliceText.includes("2026-11-22 14:30:00 UTC"), aliceText);
    assert.ok(aliceText.includes("Meaning: Approval"), aliceText);

    assert.ok(bobText.includes(`Signed by ${bob}`), bobText);
    assert.ok(bobText.includes("2026-11-22 14:30:00 UTC"), bobText);
    assert.ok(bobText.includes("Meaning: Review"), bobText);
  }
});

test("three narrow side-by-side Part 11 signatures wrap cleanly without overlapping (issue #220)", async () => {
  const columns = [
    {
      id: "sig-1",
      meaning: "authorship" as const,
      name: "Alice Alexander Example-Smythe",
      width: 0.18,
      x: 0.05,
      y: 0.5,
    },
    {
      id: "sig-2",
      meaning: "review" as const,
      name: "Bob Bartholomew Example-Jones",
      width: 0.18,
      x: 0.28,
      y: 0.5,
    },
    {
      id: "sig-3",
      meaning: "approval" as const,
      name: "Charlotte Christina Example-Montgomery",
      width: 0.18,
      x: 0.51,
      y: 0.5,
    },
  ];
  const items = await renderPart11Scenario({ signatures: columns });
  const manifestationItems = items.filter((item) => item.height <= 7);
  const signatureItems = items.filter((item) => item.height > 7);
  const col1 = manifestationItems.filter(
    (item) => item.left < 0.28 * LETTER_PAGE.widthPt - 1,
  );
  const col2 = manifestationItems.filter(
    (item) =>
      item.left >= 0.28 * LETTER_PAGE.widthPt - 1 &&
      item.left < 0.51 * LETTER_PAGE.widthPt - 1,
  );
  const col3 = manifestationItems.filter(
    (item) => item.left >= 0.51 * LETTER_PAGE.widthPt - 1,
  );

  assert.ok(col1.length >= 3);
  assert.ok(col2.length >= 3);
  assert.ok(col3.length >= 1);

  for (const item of manifestationItems) {
    assertItemInsideLetterPage(item);
    assert.ok(
      item.height >= 5,
      `"${item.text}" shrunk below readable size (${item.height})`,
    );
  }

  assertNoPairwiseOverlap([
    { items: col1, label: "Column 1 manifestation" },
    { items: col2, label: "Column 2 manifestation" },
    { items: col3, label: "Column 3 manifestation" },
    { items: signatureItems, label: "Signature values" },
  ]);

  const joinText = (group: readonly ExtractedTextItem[]) =>
    group
      .map((item) => item.text)
      .join(" ")
      .replace(/\s+/g, " ");

  assert.ok(
    joinText(col1).includes("Signed by Alice Alexander Example-Smythe"),
  );
  assert.ok(joinText(col1).includes("2026-11-22 14:30:00 UTC"));
  assert.ok(joinText(col1).includes("Meaning: Authorship"));

  assert.ok(joinText(col2).includes("Signed by Bob Bartholomew Example-Jones"));
  assert.ok(joinText(col2).includes("2026-11-22 14:30:00 UTC"));
  assert.ok(joinText(col2).includes("Meaning: Review"));

  assert.ok(
    joinText(col3).includes("Signed by Charlotte Christina Example-Montgomery"),
  );
  assert.ok(joinText(col3).includes("2026-11-22 14:30:00 UTC"));
  assert.ok(joinText(col3).includes("Meaning: Approval"));
});

test("a Part 11 signature near the right margin wraps inside the page under its box", async () => {
  const name = "Alice Alexander Example-Smythe";
  const items = await renderPart11Scenario({
    signatures: [
      {
        id: "sig-right",
        meaning: "approval",
        name,
        width: 0.24,
        x: 0.72,
        y: 0.5,
      },
    ],
  });
  const manifestationItems = items.filter((item) => item.height <= 7);
  const fieldLeft = 0.72 * LETTER_PAGE.widthPt;

  assert.ok(manifestationItems.length >= 2);

  for (const item of manifestationItems) {
    assertItemInsideLetterPage(item);
    assert.ok(
      item.left >= fieldLeft - 0.5,
      `"${item.text}" drifted left of its field (${item.left} < ${fieldLeft})`,
    );
    assert.ok(item.height >= 5);
  }

  const joined = manifestationItems
    .map((item) => item.text)
    .join(" ")
    .replace(/\s+/g, " ");

  assert.ok(joined.includes(`Signed by ${name}`), joined);
  assert.ok(joined.includes("2026-11-22 14:30:00 UTC"), joined);
  assert.ok(joined.includes("Meaning: Approval"), joined);
});

test("Part 11 signatures near the bottom of the page stay inside bounds without overlapping", async () => {
  const alice = "Alice Alexander Example-Smythe";
  const bob = "Bob Bartholomew Example-Jones";

  for (const [y, height] of [
    [0.93, 0.06],
    [0.9, 0.07],
  ] as const) {
    const items = await renderPart11Scenario({
      signatures: [
        {
          height,
          id: "sig-bottom-1",
          meaning: "approval",
          name: alice,
          width: 0.24,
          x: 0.1,
          y,
        },
        {
          height,
          id: "sig-bottom-2",
          meaning: "review",
          name: bob,
          width: 0.24,
          x: 0.4,
          y,
        },
      ],
    });
    const manifestationItems = items.filter((item) => item.height <= 7);
    const signatureItems = items.filter((item) => item.height > 7);
    const aliceManifestation = manifestationItems.filter(
      (item) => item.left < 0.4 * LETTER_PAGE.widthPt - 1,
    );
    const bobManifestation = manifestationItems.filter(
      (item) => item.left >= 0.4 * LETTER_PAGE.widthPt - 1,
    );

    assert.ok(aliceManifestation.length >= 2);
    assert.ok(bobManifestation.length >= 1);

    for (const item of manifestationItems) {
      assertItemInsideLetterPage(item);
      assert.ok(item.height >= 5);
    }

    assertNoPairwiseOverlap([
      { items: aliceManifestation, label: "Alice bottom manifestation" },
      { items: bobManifestation, label: "Bob bottom manifestation" },
      { items: signatureItems, label: "Bottom signature values" },
    ]);

    const aliceText = aliceManifestation
      .map((item) => item.text)
      .join(" ")
      .replace(/\s+/g, " ");
    const bobText = bobManifestation
      .map((item) => item.text)
      .join(" ")
      .replace(/\s+/g, " ");

    assert.ok(aliceText.includes(`Signed by ${alice}`), aliceText);
    assert.ok(aliceText.includes("2026-11-22 14:30:00 UTC"), aliceText);
    assert.ok(aliceText.includes("Meaning: Approval"), aliceText);
    assert.ok(bobText.includes(`Signed by ${bob}`), bobText);
    assert.ok(bobText.includes("2026-11-22 14:30:00 UTC"), bobText);
    assert.ok(bobText.includes("Meaning: Review"), bobText);
  }
});

test("separate-row Part 11 signatures keep clean single-line manifestations", async () => {
  const alice = "Alice Alexander Example-Smythe";
  const bob = "Bob Bartholomew Example-Jones";
  const items = await renderPart11Scenario({
    signatures: [
      {
        id: "sig-row-1",
        meaning: "approval",
        name: alice,
        width: 0.24,
        x: 0.1,
        y: 0.5,
      },
      {
        id: "sig-row-2",
        meaning: "review",
        name: bob,
        width: 0.24,
        x: 0.1,
        y: 0.7,
      },
    ],
  });
  const manifestationItems = items.filter((item) => item.height <= 7);

  assert.equal(manifestationItems.length, 2);
  for (const item of manifestationItems) {
    assertItemInsideLetterPage(item);
    assert.equal(item.height, 6.5);
  }

  assertNoPairwiseOverlap([
    { items: [manifestationItems[0]!], label: "Row 1 manifestation" },
    { items: [manifestationItems[1]!], label: "Row 2 manifestation" },
  ]);

  const texts = manifestationItems.map((item) => item.text);

  assert.ok(
    texts.includes(
      `Signed by ${alice} | 2026-11-22 14:30:00 UTC | Meaning: Approval`,
    ),
  );
  assert.ok(
    texts.includes(
      `Signed by ${bob} | 2026-11-22 14:30:00 UTC | Meaning: Review`,
    ),
  );
});

test("staggered Part 11 signatures and adjacent date fields do not collide with manifestations", async () => {
  const signedAt = Date.UTC(2026, 10, 22, 14, 30, 0) / 1000;
  const items = await renderPart11Scenario({
    extraFields: [
      {
        createdAt: signedAt - 500,
        envelopeId: "envelope-1",
        height: 0.05,
        id: "date-adjacent",
        page: 1,
        required: true,
        signerId: "part11-signer-2",
        submittedAt: signedAt,
        type: "date",
        updatedAt: signedAt,
        value: "2026-11-22",
        width: 0.2,
        x: 0.68,
        y: 0.54,
      },
    ],
    signatures: [
      {
        id: "sig-stagger-1",
        meaning: "approval",
        name: "Alice Alexander Example-Smythe",
        width: 0.24,
        x: 0.1,
        y: 0.5,
      },
      {
        id: "sig-stagger-2",
        meaning: "review",
        name: "Bob Bartholomew Example-Jones",
        width: 0.24,
        x: 0.4,
        y: 0.515,
      },
    ],
  });
  const dateItems = items.filter((item) => item.text === "2026-11-22");
  const manifestationItems = items.filter(
    (item) => item.height <= 7 && item.text !== "2026-11-22",
  );
  const signatureItems = items.filter(
    (item) => item.height > 7 && item.text !== "2026-11-22",
  );
  const aliceManifestation = manifestationItems.filter(
    (item) => item.left < 0.4 * LETTER_PAGE.widthPt - 1,
  );
  const bobManifestation = manifestationItems.filter(
    (item) => item.left >= 0.4 * LETTER_PAGE.widthPt - 1,
  );

  assert.equal(dateItems.length, 1);
  assert.ok(aliceManifestation.length >= 2);
  assert.ok(bobManifestation.length >= 2);

  for (const item of manifestationItems) {
    assertItemInsideLetterPage(item);
    assert.ok(item.height >= 5);
  }

  assertNoPairwiseOverlap([
    { items: aliceManifestation, label: "Alice staggered manifestation" },
    { items: bobManifestation, label: "Bob staggered manifestation" },
    { items: signatureItems, label: "Staggered signature values" },
    { items: dateItems, label: "Adjacent date field" },
  ]);
});

test("touching side-by-side Part 11 signatures with long unbroken names keep a clean gutter and full text", async () => {
  const longUnbroken = "Alexandrina-Constantinopoulos-Montgomery-Fitzgerald";
  const bob = "Bob Bartholomew Example-Jones";
  // Field 1 ends at x = 0.28 and Field 2 starts immediately at x = 0.28 (0 pt gap).
  const items = await renderPart11Scenario({
    signatures: [
      {
        id: "sig-touch-1",
        meaning: "responsibility",
        name: longUnbroken,
        width: 0.18,
        x: 0.1,
        y: 0.5,
      },
      {
        id: "sig-touch-2",
        meaning: "approval",
        name: bob,
        width: 0.18,
        x: 0.28,
        y: 0.5,
      },
    ],
  });
  const manifestationItems = items.filter((item) => item.height <= 7);
  const signatureItems = items.filter((item) => item.height > 7);
  const boundary = 0.28 * LETTER_PAGE.widthPt;
  const firstManifestation = manifestationItems.filter(
    (item) => item.left < boundary - 1,
  );
  const secondManifestation = manifestationItems.filter(
    (item) => item.left >= boundary - 1,
  );

  assert.ok(firstManifestation.length >= 4);
  assert.ok(secondManifestation.length >= 1);

  for (const item of manifestationItems) {
    assertItemInsideLetterPage(item);
    assert.ok(item.height >= 5);
  }

  // Every line of the left manifestation stops strictly left of the right signature.
  for (const item of firstManifestation) {
    assert.ok(
      item.right < boundary,
      `"${item.text}" crossed into the adjacent column (${item.right} >= ${boundary})`,
    );
  }

  assertNoPairwiseOverlap([
    { items: firstManifestation, label: "First touching manifestation" },
    { items: secondManifestation, label: "Second touching manifestation" },
    { items: signatureItems, label: "Touching signature values" },
  ]);

  // Every character of the unbroken name, UTC timestamp, and meaning is kept.
  const firstCompact = firstManifestation.map((item) => item.text).join("");
  const firstSpaced = firstManifestation
    .map((item) => item.text)
    .join(" ")
    .replace(/\s+/g, " ");

  assert.ok(firstCompact.includes(longUnbroken), firstCompact);
  assert.ok(firstSpaced.includes("2026-11-22 14:30:00 UTC"), firstSpaced);
  assert.ok(firstSpaced.includes("Meaning: Responsibility"), firstSpaced);
});

function assertNoOverlapWithFieldBoxes(
  items: readonly ExtractedTextItem[],
  fields: readonly FieldRecord[],
  label: string,
) {
  for (const item of items) {
    const itemBottom = item.y;
    const itemTop = item.y + item.height;

    for (const field of fields) {
      const fieldLeft = field.x * LETTER_PAGE.widthPt;
      const fieldRight = (field.x + field.width) * LETTER_PAGE.widthPt;
      const fieldTop = LETTER_PAGE.heightPt - field.y * LETTER_PAGE.heightPt;
      const fieldBottom = fieldTop - field.height * LETTER_PAGE.heightPt;
      const overlaps =
        item.left < fieldRight &&
        item.right > fieldLeft &&
        itemBottom < fieldTop &&
        itemTop > fieldBottom;

      assert.equal(
        overlaps,
        false,
        `${label} ("${item.text}" [${item.left.toFixed(2)}..${item.right.toFixed(2)}, ${itemBottom.toFixed(2)}..${itemTop.toFixed(2)}]) enters field "${field.id}" [${fieldLeft.toFixed(2)}..${fieldRight.toFixed(2)}, ${fieldBottom.toFixed(2)}..${fieldTop.toFixed(2)}]`,
      );
    }
  }
}

test("a right-edge Part 11 signature sandwiched between date fields shifts left instead of covering them", async () => {
  const signedAt = Date.UTC(2026, 10, 22, 14, 30, 0) / 1000;
  const longName = "Alice Alexander Example-Smythe-Montgomery";
  const extraFields: FieldRecord[] = [
    {
      createdAt: signedAt - 500,
      envelopeId: "envelope-1",
      height: 0.03,
      id: "date-below",
      page: 1,
      required: true,
      signerId: "part11-signer-1",
      submittedAt: signedAt,
      type: "date",
      updatedAt: signedAt,
      value: "2026-11-22",
      width: 0.24,
      x: 0.72,
      y: 0.585,
    },
    {
      createdAt: signedAt - 500,
      envelopeId: "envelope-1",
      height: 0.05,
      id: "date-above",
      page: 1,
      required: true,
      signerId: "part11-signer-1",
      submittedAt: signedAt,
      type: "date",
      updatedAt: signedAt,
      value: "2026-11-21",
      width: 0.24,
      x: 0.72,
      y: 0.445,
    },
  ];
  const items = await renderPart11Scenario({
    extraFields,
    signatures: [
      {
        height: 0.07,
        id: "sig-sandwiched-right",
        meaning: "approval",
        name: longName,
        width: 0.24,
        x: 0.72,
        y: 0.5,
      },
    ],
  });
  const dateItems = items.filter(
    (item) => item.text === "2026-11-22" || item.text === "2026-11-21",
  );
  const manifestationItems = items.filter(
    (item) =>
      item.height <= 7 &&
      item.text !== "2026-11-22" &&
      item.text !== "2026-11-21",
  );
  const signatureItems = items.filter(
    (item) =>
      item.height > 7 &&
      item.text !== "2026-11-22" &&
      item.text !== "2026-11-21",
  );

  assert.equal(dateItems.length, 2);
  assert.ok(manifestationItems.length >= 1);

  for (const item of manifestationItems) {
    assertItemInsideLetterPage(item);
    assert.ok(
      item.height >= 5,
      `"${item.text}" shrunk below readable size (${item.height})`,
    );
  }

  assertNoOverlapWithFieldBoxes(
    manifestationItems,
    extraFields,
    "Sandwiched right manifestation",
  );
  assertNoPairwiseOverlap([
    { items: manifestationItems, label: "Sandwiched right manifestation" },
    { items: signatureItems, label: "Sandwiched signature value" },
    { items: dateItems, label: "Adjacent date fields" },
  ]);

  const joined = manifestationItems
    .map((item) => item.text)
    .join(" ")
    .replace(/\s+/g, " ");

  assert.ok(joined.includes(`Signed by ${longName}`), joined);
  assert.ok(joined.includes("2026-11-22 14:30:00 UTC"), joined);
  assert.ok(joined.includes("Meaning: Approval"), joined);
});

test("a Part 11 signature boxed in horizontally and vertically fits in collision-free space without covering fields", async () => {
  const signedAt = Date.UTC(2026, 10, 22, 14, 30, 0) / 1000;
  const longName = "Alice Alexander Example-Smythe-Montgomery";
  const extraFields: FieldRecord[] = [
    // Blocks shifting left AND blocks placing beside on the left.
    {
      createdAt: signedAt - 500,
      envelopeId: "envelope-1",
      height: 0.2,
      id: "text-left-blocker",
      page: 1,
      required: true,
      signerId: "part11-signer-1",
      submittedAt: signedAt,
      type: "text",
      updatedAt: signedAt,
      value: "LEFT",
      width: 0.65,
      x: 0.04,
      y: 0.44,
    },
    // Blocks directly below with an ~11.88 pt vertical gap.
    {
      createdAt: signedAt - 500,
      envelopeId: "envelope-1",
      height: 0.03,
      id: "date-boxed-below",
      page: 1,
      required: true,
      signerId: "part11-signer-1",
      submittedAt: signedAt,
      type: "date",
      updatedAt: signedAt,
      value: "2026-11-22",
      width: 0.24,
      x: 0.72,
      y: 0.585,
    },
    // Blocks directly above with a ~3.96 pt vertical gap.
    {
      createdAt: signedAt - 500,
      envelopeId: "envelope-1",
      height: 0.05,
      id: "date-boxed-above",
      page: 1,
      required: true,
      signerId: "part11-signer-1",
      submittedAt: signedAt,
      type: "date",
      updatedAt: signedAt,
      value: "2026-11-21",
      width: 0.24,
      x: 0.72,
      y: 0.445,
    },
  ];
  const items = await renderPart11Scenario({
    extraFields,
    signatures: [
      {
        height: 0.07,
        id: "sig-boxed",
        meaning: "approval",
        name: longName,
        width: 0.24,
        x: 0.72,
        y: 0.5,
      },
    ],
  });
  const fieldItems = items.filter(
    (item) =>
      item.text === "2026-11-22" ||
      item.text === "2026-11-21" ||
      item.text === "LEFT",
  );
  const manifestationItems = items.filter(
    (item) => item.height <= 7 && !fieldItems.includes(item),
  );
  const signatureItems = items.filter(
    (item) => item.height > 7 && !fieldItems.includes(item),
  );

  assert.equal(fieldItems.length, 3);
  assert.ok(manifestationItems.length >= 1);

  for (const item of manifestationItems) {
    assertItemInsideLetterPage(item);
  }

  assertNoOverlapWithFieldBoxes(
    manifestationItems,
    extraFields,
    "Boxed manifestation",
  );
  assertNoPairwiseOverlap([
    { items: manifestationItems, label: "Boxed manifestation" },
    { items: signatureItems, label: "Boxed signature value" },
    { items: fieldItems, label: "Surrounding fields" },
  ]);

  const joined = manifestationItems
    .map((item) => item.text)
    .join(" ")
    .replace(/\s+/g, " ");

  assert.ok(joined.includes(`Signed by ${longName}`), joined);
  assert.ok(joined.includes("2026-11-22 14:30:00 UTC"), joined);
  assert.ok(joined.includes("Meaning: Approval"), joined);
});

test("a Part 11 signature touched directly above and below places its manifestation beside the box", async () => {
  const signedAt = Date.UTC(2026, 10, 22, 14, 30, 0) / 1000;
  const longName = "Alice Alexander Example-Smythe";
  const extraFields: FieldRecord[] = [
    // Touches bottom edge of signature (y = 0.5 + 0.07 = 0.57, 0 pt gap).
    {
      createdAt: signedAt - 500,
      envelopeId: "envelope-1",
      height: 0.04,
      id: "date-touch-below",
      page: 1,
      required: true,
      signerId: "part11-signer-1",
      submittedAt: signedAt,
      type: "date",
      updatedAt: signedAt,
      value: "2026-11-22",
      width: 0.24,
      x: 0.72,
      y: 0.57,
    },
    // Touches top edge of signature (y + h = 0.46 + 0.04 = 0.50, 0 pt gap).
    {
      createdAt: signedAt - 500,
      envelopeId: "envelope-1",
      height: 0.04,
      id: "date-touch-above",
      page: 1,
      required: true,
      signerId: "part11-signer-1",
      submittedAt: signedAt,
      type: "date",
      updatedAt: signedAt,
      value: "2026-11-21",
      width: 0.24,
      x: 0.72,
      y: 0.46,
    },
  ];
  const items = await renderPart11Scenario({
    extraFields,
    signatures: [
      {
        height: 0.07,
        id: "sig-touch-vertical",
        meaning: "review",
        name: longName,
        width: 0.24,
        x: 0.72,
        y: 0.5,
      },
    ],
  });
  const dateItems = items.filter(
    (item) => item.text === "2026-11-22" || item.text === "2026-11-21",
  );
  const manifestationItems = items.filter(
    (item) =>
      item.height <= 7 &&
      item.text !== "2026-11-22" &&
      item.text !== "2026-11-21",
  );
  const signatureItems = items.filter(
    (item) =>
      item.height > 7 &&
      item.text !== "2026-11-22" &&
      item.text !== "2026-11-21",
  );

  assert.equal(dateItems.length, 2);
  assert.ok(manifestationItems.length >= 1);

  for (const item of manifestationItems) {
    assertItemInsideLetterPage(item);
    assert.ok(
      item.height >= 5,
      `"${item.text}" shrunk below readable size (${item.height})`,
    );
  }

  assertNoOverlapWithFieldBoxes(
    manifestationItems,
    extraFields,
    "Beside manifestation",
  );
  assertNoPairwiseOverlap([
    { items: manifestationItems, label: "Beside manifestation" },
    { items: signatureItems, label: "Vertically touched signature value" },
    { items: dateItems, label: "Touching date fields" },
  ]);

  const joined = manifestationItems
    .map((item) => item.text)
    .join(" ")
    .replace(/\s+/g, " ");

  assert.ok(joined.includes(`Signed by ${longName}`), joined);
  assert.ok(joined.includes("2026-11-22 14:30:00 UTC"), joined);
  assert.ok(joined.includes("Meaning: Review"), joined);
});
