import assert from "node:assert/strict";
import test from "node:test";

import {
  fieldPlacementSchema,
  replaceFieldsResponseSchema,
  signingFieldSubmissionSchema,
} from "./field.ts";

const placement = {
  height: 0.05,
  page: 1,
  signerId: "signer-1",
  width: 0.2,
  x: 0.1,
  y: 0.1,
};

test("fields that fill themselves in or are the signature are always required", () => {
  for (const type of ["signature", "initials", "date", "name"] as const) {
    assert.equal(
      fieldPlacementSchema.safeParse({ ...placement, required: false, type })
        .success,
      false,
      `an optional ${type} field was accepted`,
    );
    assert.equal(
      fieldPlacementSchema.safeParse({ ...placement, type }).success,
      true,
      `a ${type} field was refused`,
    );
  }
});

test("a text field may be optional", () => {
  assert.equal(
    fieldPlacementSchema.safeParse({
      ...placement,
      required: false,
      type: "text",
    }).success,
    true,
  );
});

test("dropdown choices accept 80-code-point emoji strings and refuse lone surrogates", () => {
  const eightyWithEmoji = `${"a".repeat(79)}😀`;
  const eightyOneWithEmoji = `${"a".repeat(80)}😀`;
  const loneHighSurrogate = `${"a".repeat(79)}\ud83d`;
  const loneLowSurrogate = `${"a".repeat(79)}\ude00`;

  assert.equal(
    fieldPlacementSchema.safeParse({
      ...placement,
      options: [eightyWithEmoji, "No"],
      type: "dropdown",
    }).success,
    true,
  );

  assert.equal(
    signingFieldSubmissionSchema.safeParse({
      fieldId: "field-1",
      type: "dropdown",
      value: eightyWithEmoji,
    }).success,
    true,
  );

  assert.equal(
    replaceFieldsResponseSchema.safeParse({
      envelopeId: "env-1",
      fields: [
        {
          ...placement,
          id: "field-1",
          options: [eightyWithEmoji, "No"],
          type: "dropdown",
        },
      ],
      fieldsRevision: 1,
      redirectPath: "/envelopes/env-1/review",
      updatedAt: 1700000000,
    }).success,
    true,
  );

  assert.equal(
    fieldPlacementSchema.safeParse({
      ...placement,
      options: [eightyOneWithEmoji],
      type: "dropdown",
    }).success,
    false,
  );

  for (const broken of [loneHighSurrogate, loneLowSurrogate]) {
    assert.equal(
      fieldPlacementSchema.safeParse({
        ...placement,
        options: [broken],
        type: "dropdown",
      }).success,
      false,
    );

    assert.equal(
      signingFieldSubmissionSchema.safeParse({
        fieldId: "field-1",
        type: "dropdown",
        value: broken,
      }).success,
      false,
    );

    assert.equal(
      fieldPlacementSchema.safeParse({
        ...placement,
        groupId: "group-1",
        label: broken,
        type: "radio",
      }).success,
      false,
    );
  }
});
