// Keyboard shortcuts on the Prepare page. Backspace and Delete only remove the
// selected field when focus is on the document canvas itself (the page, the
// viewport, or the selected placed field), never while focus is on a control
// in Field settings, a toolbar, header navigation, or a dialog.

export type ShortcutTargetElement = {
  closest: (selector: string) => ShortcutTargetElement | null;
  getAttribute: (name: string) => string | null;
  isContentEditable?: boolean;
  tagName: string;
};

export type CanvasFocusContainer<TNode> = {
  contains: (node: TNode) => boolean;
};

type BlurTargetElement = {
  blur: () => void;
  tagName: string;
};

export type DeleteFieldKeydownContext = {
  activeElement?: unknown;
  altKey?: boolean;
  ctrlKey?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  isDialogOpen?: boolean;
  isFieldInteracting?: boolean;
  key: string;
  metaKey?: boolean;
  target: unknown;
};

const TEXT_ENTRY_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[contenteditable='plaintext-only']",
  "[role='textbox']",
  "[role='searchbox']",
  "[role='combobox']",
  "[role='spinbutton']",
].join(", ");

const DIALOG_SELECTOR =
  "[role='dialog'], [role='alertdialog'], [aria-modal='true']";

const PLACED_FIELD_SELECTOR = "[data-placed-field='true']";
const CANVAS_CONTAINER_SELECTOR = "[data-field-viewport], [data-paper-grid]";

const NON_CANVAS_INTERACTIVE_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "summary",
  "textarea",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[contenteditable='plaintext-only']",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='link']",
  "[role='listbox']",
  "[role='menu']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='radio']",
  "[role='searchbox']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='switch']",
  "[role='tab']",
  "[role='textbox']",
].join(", ");

function asTargetElement(value: unknown): ShortcutTargetElement | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<ShortcutTargetElement>;

  if (
    typeof candidate.tagName !== "string" ||
    typeof candidate.closest !== "function" ||
    typeof candidate.getAttribute !== "function"
  ) {
    return null;
  }

  return candidate as ShortcutTargetElement;
}

/**
 * True when an element represents the document canvas or the currently
 * selected placed field, so Backspace/Delete may safely remove that field.
 */
export function isCanvasDeleteTarget(element: ShortcutTargetElement): boolean {
  if (
    element.isContentEditable ||
    element.closest(TEXT_ENTRY_SELECTOR) !== null ||
    element.closest(DIALOG_SELECTOR) !== null
  ) {
    return false;
  }

  const tagName = element.tagName.toUpperCase();

  if (tagName === "BODY" || tagName === "HTML") {
    return true;
  }

  const placedField = element.closest(PLACED_FIELD_SELECTOR);

  if (placedField !== null) {
    return placedField.getAttribute("aria-pressed") === "true";
  }

  if (element.closest(CANVAS_CONTAINER_SELECTOR) !== null) {
    return element.closest(NON_CANVAS_INTERACTIVE_SELECTOR) === null;
  }

  return false;
}

/**
 * True when a window-level keydown event should delete the currently selected
 * field on the Prepare page.
 */
export function shouldDeleteSelectedFieldOnKeydown(
  context: DeleteFieldKeydownContext,
): boolean {
  if (
    context.defaultPrevented ||
    context.isComposing ||
    context.isFieldInteracting ||
    context.isDialogOpen
  ) {
    return false;
  }

  if (context.key !== "Backspace" && context.key !== "Delete") {
    return false;
  }

  if (context.altKey || context.ctrlKey || context.metaKey) {
    return false;
  }

  const targetElement = asTargetElement(context.target);
  const activeElement = asTargetElement(context.activeElement);

  if (targetElement === null) {
    return activeElement !== null && isCanvasDeleteTarget(activeElement);
  }

  if (!isCanvasDeleteTarget(targetElement)) {
    return false;
  }

  if (activeElement !== null && activeElement !== targetElement) {
    return isCanvasDeleteTarget(activeElement);
  }

  return true;
}

/**
 * Clears focus from a non-body element unless it is already inside `keepWithin`.
 * Used when clicking or placing a field on the document canvas so browsers that
 * do not move focus on prevented pointerdowns or button clicks (such as Safari
 * and Firefox) do not leave focus stuck on a sidebar tool, inspector control,
 * or previously focused field.
 */
export function releaseStaleFocusForCanvas<TNode>(
  activeElement: TNode,
  keepWithin?: CanvasFocusContainer<TNode> | null,
): boolean {
  if (!activeElement || typeof activeElement !== "object") {
    return false;
  }

  const candidate = activeElement as Partial<BlurTargetElement>;

  if (
    typeof candidate.tagName !== "string" ||
    typeof candidate.blur !== "function"
  ) {
    return false;
  }

  const tagName = candidate.tagName.toUpperCase();

  if (tagName === "BODY" || tagName === "HTML") {
    return false;
  }

  if (keepWithin && keepWithin.contains(activeElement)) {
    return false;
  }

  candidate.blur();
  return true;
}
