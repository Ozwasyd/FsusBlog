const FIRST_VISIBLE_FOCUSABLE = 'input:not([type="hidden"]):not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'

const VALIDATION_ERROR_FOCUS_SELECTOR = '.write-validation-form [aria-invalid="true"]:not([disabled]):not([tabindex="-1"])'

// Element Plus exposes validation state per field through the public fields
// API, so the first-error fallback descends from the field root instead of
// targeting the internal form-item class.
function findFirstFocusable(root: ParentNode): HTMLElement | null {
  const candidate = root.querySelector<HTMLElement>(VALIDATION_ERROR_FOCUS_SELECTOR)
  if (candidate && !candidate.hidden && !candidate.closest('[aria-hidden="true"]')) {
    return candidate
  }
  return null
}

function findFirstFocusableIn(firstErrorFieldRoot: HTMLElement): HTMLElement | null {
  const candidate = firstErrorFieldRoot.querySelector<HTMLElement>(FIRST_VISIBLE_FOCUSABLE)
  if (candidate && !candidate.hidden && !candidate.closest('[aria-hidden="true"]')) {
    return candidate
  }
  return null
}

export function focusFirstArticleValidationError(firstErrorFieldRoot?: HTMLElement | null): boolean {
  const target = findFirstFocusable(document) ?? (firstErrorFieldRoot ? findFirstFocusableIn(firstErrorFieldRoot) : null)
  if (!target) {
    return false
  }

  target.focus({ preventScroll: true })
  target.scrollIntoView({ behavior: 'auto', block: 'center' })
  return true
}
