import assert from "node:assert/strict";
import test from "node:test";

import {
  countAnswerableFields,
  describeChoiceFieldProblem,
  describeEntryProblem,
  DROPDOWN_ENTRY_MESSAGE,
  findChoiceFieldProblem,
  isNumberEntry,
  judgeRadioGroups,
  labelTextToShow,
  MAX_FIELD_OPTIONS,
  NUMBER_ENTRY_MESSAGE,
  optionsTextToShow,
  parseOptionLines,
} from "./field-choices.ts";

test("an editor box shows what was typed only while it still stands for what is saved", () => {
  const saved = ["Monthly", "Yearly"];

  // Mid-thought: the empty line and the trailing space are kept.
  assert.equal(
    optionsTextToShow("Monthly\nYearly \n", saved),
    "Monthly\nYearly \n",
  );
  // The other copy of the editor: never typed in, or typed in a while ago.
  assert.equal(optionsTextToShow("", saved), "Monthly\nYearly");
  assert.equal(
    optionsTextToShow("Monthly\nYearly", [...saved, "Once"]),
    "Monthly\nYearly\nOnce",
  );
  assert.equal(optionsTextToShow("Yearly\nMonthly", saved), "Monthly\nYearly");
  assert.equal(optionsTextToShow("Old", null), "");
  assert.equal(optionsTextToShow(" \n", []), " \n");

  assert.equal(labelTextToShow("Yes ", "Yes"), "Yes ");
  assert.equal(labelTextToShow("", "Yes"), "Yes");
  assert.equal(labelTextToShow("Ye", "Yes"), "Yes");
  assert.equal(labelTextToShow("Old", undefined), "");
  assert.equal(labelTextToShow("  ", null), "  ");
});

test("a number field takes plain and comma-grouped numbers and nothing else", () => {
  for (const entry of [
    "0",
    "1250",
    "12.5",
    "-3",
    "+7.25",
    " 42 ",
    "1,250",
    "1,250,000.75",
    "-12,000",
  ]) {
    assert.equal(isNumberEntry(entry), true, entry);
  }

  for (const entry of [
    "",
    "abc",
    "12,5",
    "1,25",
    "1.2.3",
    "12.",
    ".5",
    "1e5",
    "1 250",
    "12,5000",
    "٣",
    "12%",
    "$12",
    "--1",
    "1".repeat(19),
  ]) {
    assert.equal(isNumberEntry(entry), false, entry);
  }
});

test("choices are read one per line, without blanks or repeats", () => {
  assert.deepEqual(parseOptionLines(" Yes \n\nNo\r\nYes\n  Maybe"), [
    "Yes",
    "No",
    "Maybe",
  ]);
  assert.deepEqual(parseOptionLines(""), []);
  assert.equal(
    parseOptionLines(
      Array.from({ length: 40 }, (_, index) => `Choice ${index}`).join("\n"),
    ).length,
    MAX_FIELD_OPTIONS,
  );
  assert.equal(parseOptionLines("x".repeat(200))[0].length, 80);
});

test("choices truncate on whole-character boundaries without splitting surrogate pairs", () => {
  const eightyWithEmoji = `${"a".repeat(79)}😀`;
  const eightyOneWithTrailingAscii = `${"a".repeat(79)}😀Z`;
  const eightyOneWithTrailingEmoji = `${"a".repeat(80)}😀`;
  const family = "👨‍👩‍👧"; // 5 code points in one grapheme cluster
  const eightyWithFamily = `${"a".repeat(75)}${family}`;
  const eightyOneWithFamily = `${"a".repeat(76)}${family}`;
  const heart = "❤️"; // 2 code points (U+2764 U+FE0F)
  const flag = "🇺🇸"; // 2 regional-indicator code points

  // 80 code points ending in an astral emoji (81 UTF-16 code units) stays intact.
  const kept = parseOptionLines(eightyWithEmoji);
  assert.deepEqual(kept, [eightyWithEmoji]);
  assert.equal(kept[0].isWellFormed(), true);

  // 81 code points keeps the emoji at code point 80 and drops the 81st.
  const trimmedAfterEmoji = parseOptionLines(eightyOneWithTrailingAscii);
  assert.deepEqual(trimmedAfterEmoji, [eightyWithEmoji]);
  assert.equal(trimmedAfterEmoji[0].isWellFormed(), true);

  // 80 ASCII chars followed by an emoji drops the emoji cleanly.
  const droppedEmoji = parseOptionLines(eightyOneWithTrailingEmoji);
  assert.deepEqual(droppedEmoji, ["a".repeat(80)]);
  assert.equal(droppedEmoji[0].isWellFormed(), true);

  // Multi-code-point grapheme clusters stay whole or are dropped together.
  assert.deepEqual(parseOptionLines(eightyWithFamily), [eightyWithFamily]);
  assert.deepEqual(parseOptionLines(`${eightyWithFamily}Z`), [
    eightyWithFamily,
  ]);
  assert.deepEqual(parseOptionLines(eightyOneWithFamily), ["a".repeat(76)]);
  assert.deepEqual(parseOptionLines(`${"a".repeat(78)}${heart}`), [
    `${"a".repeat(78)}${heart}`,
  ]);
  assert.deepEqual(parseOptionLines(`${"a".repeat(79)}${heart}`), [
    "a".repeat(79),
  ]);
  assert.deepEqual(parseOptionLines(`${"a".repeat(78)}${flag}`), [
    `${"a".repeat(78)}${flag}`,
  ]);
  assert.deepEqual(parseOptionLines(`${"a".repeat(79)}${flag}`), [
    "a".repeat(79),
  ]);

  // Lone surrogates already present in input are replaced so JSONB saves never fail.
  const sanitized = parseOptionLines(`${"a".repeat(79)}\ud83d`);
  assert.deepEqual(sanitized, [`${"a".repeat(79)}\ufffd`]);
  assert.equal(sanitized[0].isWellFormed(), true);

  // Trailing whitespace exposed by truncation is still trimmed.
  assert.deepEqual(parseOptionLines(`${"a".repeat(79)} 😀`), ["a".repeat(79)]);

  // Editor round-trip preserves typed text for 80-code-point emoji choices.
  assert.equal(
    optionsTextToShow(`${eightyWithEmoji}\nNo`, [eightyWithEmoji, "No"]),
    `${eightyWithEmoji}\nNo`,
  );
});

test("a dropdown needs two choices and a radio button needs company", () => {
  const signerId = "signer-1";

  assert.equal(findChoiceFieldProblem([]), null);
  assert.equal(
    findChoiceFieldProblem([
      { options: ["Yes", "No"], required: true, signerId, type: "dropdown" },
      { groupId: "g1", required: true, signerId, type: "radio" },
      { groupId: "g1", required: true, signerId, type: "radio" },
      { required: true, signerId, type: "signature" },
    ]),
    null,
  );

  for (const options of [undefined, null, [], ["Only"]]) {
    assert.deepEqual(
      findChoiceFieldProblem([
        { options, required: false, signerId, type: "dropdown" },
      ]),
      { kind: "dropdown_options", signerId },
    );
  }

  const lonely = findChoiceFieldProblem([
    { groupId: "g1", required: true, signerId, type: "radio" },
    { groupId: "g1", required: true, signerId, type: "radio" },
    { groupId: "g2", required: true, signerId: "signer-2", type: "radio" },
  ]);

  assert.deepEqual(lonely, { kind: "radio_group_size", signerId: "signer-2" });
  assert.match(describeChoiceFieldProblem(lonely!, "Ada"), /Ada/);
});

test("a group of radio buttons counts as one thing to do", () => {
  const signerId = "signer-1";

  assert.equal(
    countAnswerableFields(
      [
        { required: true, signerId, type: "signature" },
        { groupId: "g1", required: true, signerId, type: "radio" },
        { groupId: "g1", required: true, signerId, type: "radio" },
        { groupId: "g1", required: true, signerId, type: "radio" },
        { groupId: "g2", required: true, signerId, type: "radio" },
        { groupId: "g2", required: true, signerId, type: "radio" },
        { required: false, signerId, type: "checkbox" },
      ],
      (field) => field.required,
    ),
    3,
  );
});

test("what a signer enters must be a number, or one of the choices offered", () => {
  assert.equal(describeEntryProblem({ type: "number" }, "12.5"), null);
  assert.equal(
    describeEntryProblem({ type: "number" }, "twelve"),
    NUMBER_ENTRY_MESSAGE,
  );
  assert.equal(
    describeEntryProblem({ options: ["Yes", "No"], type: "dropdown" }, "Yes"),
    null,
  );

  for (const [options, value] of [
    [["Yes", "No"], "Maybe"],
    [["Yes", "No"], "yes"],
    [[], "Yes"],
    [undefined, "Yes"],
  ] as const) {
    assert.equal(
      describeEntryProblem({ options, type: "dropdown" }, value),
      DROPDOWN_ENTRY_MESSAGE,
    );
  }

  // Free text has no rule of this kind.
  assert.equal(describeEntryProblem({ type: "text" }, "anything"), null);
});

test("radio buttons are judged a group at a time", () => {
  const signerId = "signer-1";
  const button = (id: string, groupId: string, required: boolean) => ({
    groupId,
    id,
    required,
    signerId,
    type: "radio",
  });
  const fields = [
    button("a1", "a", true),
    button("a2", "a", true),
    button("b1", "b", false),
    button("b2", "b", false),
    { id: "sig", required: true, signerId, type: "signature" },
  ];
  const judge = (...chosen: string[]) =>
    judgeRadioGroups(fields, (field) => chosen.includes(field.id));

  assert.equal(judge("a1"), "ok");
  assert.equal(judge("a2", "b1"), "ok");
  // The required group has no answer.
  assert.equal(judge(), "missing");
  assert.equal(judge("b2"), "missing");
  // Two answers in one group, required or not.
  assert.equal(judge("a1", "a2"), "too_many");
  assert.equal(judge("a1", "b1", "b2"), "too_many");
  // Too many wins over missing: it is the one that cannot be a mistake.
  assert.equal(judge("b1", "b2"), "too_many");
});
