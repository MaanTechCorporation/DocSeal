import assert from "node:assert/strict";
import test from "node:test";

import {
  releaseStaleFocusForCanvas,
  shouldDeleteSelectedFieldOnKeydown,
  type ShortcutTargetElement,
} from "./prepare-shortcuts.ts";

type MockElement = ShortcutTargetElement & {
  attributes: Record<string, string>;
  blur: () => void;
  blurred: boolean;
  contains: (node: MockElement | null) => boolean;
  parent: MockElement | null;
};

function matchesSingleSelector(
  element: MockElement,
  rawSelector: string,
): boolean {
  const selector = rawSelector.trim();

  if (!selector) {
    return false;
  }

  const attrMatch = /^\[([a-zA-Z0-9_-]+)(?:=['"]([^'"]*)['"])?\]$/.exec(
    selector,
  );

  if (attrMatch) {
    const [, attrName, expectedValue] = attrMatch;
    const actualValue = element.getAttribute(attrName);

    if (actualValue === null) {
      return false;
    }

    return expectedValue === undefined || actualValue === expectedValue;
  }

  return element.tagName.toLowerCase() === selector.toLowerCase();
}

function createElement(
  tagName: string,
  options: {
    attributes?: Record<string, string>;
    isContentEditable?: boolean;
    parent?: MockElement | null;
  } = {},
): MockElement {
  const attributes = options.attributes ?? {};
  const element: MockElement = {
    attributes,
    blur() {
      element.blurred = true;
    },
    blurred: false,
    closest(selectorList: string): ShortcutTargetElement | null {
      const selectors = selectorList.split(",").map((part) => part.trim());
      let current: MockElement | null = element;

      while (current !== null) {
        if (
          selectors.some((selector) =>
            matchesSingleSelector(current!, selector),
          )
        ) {
          return current;
        }

        current = current.parent;
      }

      return null;
    },
    contains(node: MockElement | null): boolean {
      let current = node;

      while (current !== null) {
        if (current === element) {
          return true;
        }

        current = current.parent;
      }

      return false;
    },
    getAttribute(name: string): string | null {
      return Object.prototype.hasOwnProperty.call(attributes, name)
        ? attributes[name]
        : null;
    },
    isContentEditable: options.isContentEditable ?? false,
    parent: options.parent ?? null,
    tagName: tagName.toUpperCase(),
  };

  return element;
}

test("Backspace and Delete do not delete the selected field from Field settings controls", () => {
  const body = createElement("body");
  const fieldSettings = createElement("section", {
    attributes: { "aria-label": "Field settings", role: "region" },
    parent: body,
  });
  const requiredButton = createElement("button", {
    attributes: { "aria-pressed": "true", type: "button" },
    parent: fieldSettings,
  });
  const optionalButton = createElement("button", {
    attributes: { "aria-pressed": "false", type: "button" },
    parent: fieldSettings,
  });
  const assignSignerButton = createElement("button", {
    attributes: { "aria-pressed": "true", type: "button" },
    parent: fieldSettings,
  });
  const deleteButton = createElement("button", {
    attributes: { type: "button" },
    parent: fieldSettings,
  });
  const choicesTextarea = createElement("textarea", {
    parent: fieldSettings,
  });
  const radioLabelInput = createElement("input", {
    parent: fieldSettings,
  });
  const customSwitch = createElement("div", {
    attributes: { role: "switch" },
    parent: fieldSettings,
  });
  const customCheckbox = createElement("div", {
    attributes: { role: "checkbox" },
    parent: fieldSettings,
  });
  const fieldSettingsHeading = createElement("p", {
    parent: fieldSettings,
  });

  for (const key of ["Backspace", "Delete"] as const) {
    for (const target of [
      requiredButton,
      optionalButton,
      assignSignerButton,
      deleteButton,
      choicesTextarea,
      radioLabelInput,
      customSwitch,
      customCheckbox,
      fieldSettingsHeading,
    ]) {
      assert.equal(
        shouldDeleteSelectedFieldOnKeydown({
          activeElement: target,
          key,
          target,
        }),
        false,
        `${key} should not delete when focused on ${target.tagName}`,
      );
    }
  }
});

test("Backspace and Delete do not delete from toolbars, header navigation, dialogs, or editable elements", () => {
  const body = createElement("body");
  const header = createElement("header", { parent: body });
  const backLink = createElement("a", {
    attributes: { href: "/envelopes/1/signers" },
    parent: header,
  });
  const nextButton = createElement("button", { parent: header });

  const sidebar = createElement("aside", { parent: body });
  const fieldToolButton = createElement("button", {
    attributes: { "aria-pressed": "false" },
    parent: sidebar,
  });
  const fieldToolIcon = createElement("svg", { parent: fieldToolButton });
  const signerCardButton = createElement("button", {
    attributes: { "aria-pressed": "true" },
    parent: sidebar,
  });

  const signerSelect = createElement("select", { parent: body });
  const contentEditableDiv = createElement("div", {
    attributes: { contenteditable: "true" },
    isContentEditable: true,
    parent: body,
  });
  const contentEditableChild = createElement("span", {
    parent: contentEditableDiv,
  });

  const dialog = createElement("div", {
    attributes: { "aria-modal": "true", role: "dialog" },
    parent: body,
  });
  const dialogButton = createElement("button", { parent: dialog });
  const dialogSurface = createElement("div", { parent: dialog });

  for (const target of [
    backLink,
    nextButton,
    fieldToolButton,
    fieldToolIcon,
    signerCardButton,
    signerSelect,
    contentEditableDiv,
    contentEditableChild,
    dialogButton,
    dialogSurface,
  ]) {
    assert.equal(
      shouldDeleteSelectedFieldOnKeydown({
        activeElement: target,
        key: "Backspace",
        target,
      }),
      false,
    );
  }

  // Even if focus falls on body while a modal dialog is open, do not delete.
  assert.equal(
    shouldDeleteSelectedFieldOnKeydown({
      activeElement: body,
      isDialogOpen: true,
      key: "Backspace",
      target: body,
    }),
    false,
  );
});

test("Backspace and Delete delete the selected field only when focus is on the canvas or the selected placed field", () => {
  const html = createElement("html");
  const body = createElement("body", { parent: html });
  const paperGrid = createElement("div", {
    attributes: { "data-paper-grid": "" },
    parent: body,
  });
  const viewport = createElement("div", {
    attributes: { "data-field-viewport": "" },
    parent: paperGrid,
  });
  const pdfCanvas = createElement("canvas", { parent: viewport });
  const armedPlaceOverlay = createElement("button", {
    attributes: { "aria-label": "Place Text on page 1", type: "button" },
    parent: viewport,
  });
  const selectedField = createElement("div", {
    attributes: {
      "aria-pressed": "true",
      "data-placed-field": "true",
      role: "button",
    },
    parent: viewport,
  });
  const selectedFieldLabel = createElement("span", { parent: selectedField });
  const selectedFieldResizeHandle = createElement("button", {
    attributes: { type: "button" },
    parent: selectedField,
  });
  const unselectedField = createElement("div", {
    attributes: {
      "aria-pressed": "false",
      "data-placed-field": "true",
      role: "button",
    },
    parent: viewport,
  });

  for (const key of ["Backspace", "Delete"] as const) {
    for (const target of [
      html,
      body,
      paperGrid,
      viewport,
      pdfCanvas,
      selectedField,
      selectedFieldLabel,
      selectedFieldResizeHandle,
    ]) {
      assert.equal(
        shouldDeleteSelectedFieldOnKeydown({
          activeElement: target,
          key,
          target,
        }),
        true,
        `${key} should delete when focused on ${target.tagName}`,
      );
    }

    // Focus on another, unselected placed field or the armed placement overlay must not delete.
    assert.equal(
      shouldDeleteSelectedFieldOnKeydown({
        activeElement: unselectedField,
        key,
        target: unselectedField,
      }),
      false,
    );
    assert.equal(
      shouldDeleteSelectedFieldOnKeydown({
        activeElement: armedPlaceOverlay,
        key,
        target: armedPlaceOverlay,
      }),
      false,
    );
  }
});

test("guards reject non-delete keys, modifiers, composing, drag interactions, and mismatched focus", () => {
  const body = createElement("body");
  const requiredButton = createElement("button", {
    attributes: { "aria-pressed": "true" },
    parent: body,
  });

  assert.equal(
    shouldDeleteSelectedFieldOnKeydown({ key: " ", target: body }),
    false,
  );
  assert.equal(
    shouldDeleteSelectedFieldOnKeydown({ key: "Enter", target: body }),
    false,
  );
  assert.equal(
    shouldDeleteSelectedFieldOnKeydown({
      altKey: true,
      key: "Backspace",
      target: body,
    }),
    false,
  );
  assert.equal(
    shouldDeleteSelectedFieldOnKeydown({
      ctrlKey: true,
      key: "Backspace",
      target: body,
    }),
    false,
  );
  assert.equal(
    shouldDeleteSelectedFieldOnKeydown({
      metaKey: true,
      key: "Backspace",
      target: body,
    }),
    false,
  );
  assert.equal(
    shouldDeleteSelectedFieldOnKeydown({
      defaultPrevented: true,
      key: "Backspace",
      target: body,
    }),
    false,
  );
  assert.equal(
    shouldDeleteSelectedFieldOnKeydown({
      isComposing: true,
      key: "Backspace",
      target: body,
    }),
    false,
  );
  assert.equal(
    shouldDeleteSelectedFieldOnKeydown({
      isFieldInteracting: true,
      key: "Backspace",
      target: body,
    }),
    false,
  );
  assert.equal(
    shouldDeleteSelectedFieldOnKeydown({ key: "Backspace", target: null }),
    false,
  );
  // Synthetic event dispatched on window/body while focus is still on Required.
  assert.equal(
    shouldDeleteSelectedFieldOnKeydown({
      activeElement: requiredButton,
      key: "Backspace",
      target: {},
    }),
    false,
  );
  assert.equal(
    shouldDeleteSelectedFieldOnKeydown({
      activeElement: requiredButton,
      key: "Backspace",
      target: body,
    }),
    false,
  );
  // Synthetic event dispatched on window while focus is on body.
  assert.equal(
    shouldDeleteSelectedFieldOnKeydown({
      activeElement: body,
      key: "Backspace",
      target: {},
    }),
    true,
  );
});

test("releaseStaleFocusForCanvas clears focus from prior fields, inspector controls, and sidebar tools", () => {
  const html = createElement("html");
  const body = createElement("body", { parent: html });
  const viewport = createElement("div", {
    attributes: { "data-field-viewport": "" },
    parent: body,
  });
  const fieldA = createElement("div", {
    attributes: {
      "aria-pressed": "false",
      "data-placed-field": "true",
      role: "button",
    },
    parent: viewport,
  });
  const fieldB = createElement("div", {
    attributes: {
      "aria-pressed": "true",
      "data-placed-field": "true",
      role: "button",
    },
    parent: viewport,
  });
  const fieldBHandle = createElement("button", {
    attributes: { type: "button" },
    parent: fieldB,
  });
  const requiredButton = createElement("button", {
    attributes: { "aria-pressed": "true", type: "button" },
    parent: body,
  });
  const sidebarToolButton = createElement("button", {
    attributes: { "aria-pressed": "true", type: "button" },
    parent: body,
  });

  // Clicking Field B while Field A holds keyboard focus blurs Field A.
  assert.equal(releaseStaleFocusForCanvas(fieldA, fieldB), true);
  assert.equal(fieldA.blurred, true);

  // Clicking Field B while focus is already on Field B (or its resize handle) keeps focus.
  assert.equal(releaseStaleFocusForCanvas(fieldB, fieldB), false);
  assert.equal(fieldB.blurred, false);
  assert.equal(releaseStaleFocusForCanvas(fieldBHandle, fieldB), false);
  assert.equal(fieldBHandle.blurred, false);

  // Clicking a placed field while focus is on Required in Field settings blurs Required.
  assert.equal(releaseStaleFocusForCanvas(requiredButton, fieldB), true);
  assert.equal(requiredButton.blurred, true);

  // Placing a field while a sidebar tool button retains focus (Safari/Firefox) blurs it.
  assert.equal(releaseStaleFocusForCanvas(sidebarToolButton), true);
  assert.equal(sidebarToolButton.blurred, true);

  // Never blurs body, html, or null.
  assert.equal(releaseStaleFocusForCanvas(body, fieldB), false);
  assert.equal(body.blurred, false);
  assert.equal(releaseStaleFocusForCanvas(html), false);
  assert.equal(html.blurred, false);
  assert.equal(releaseStaleFocusForCanvas(null, fieldB), false);
});
