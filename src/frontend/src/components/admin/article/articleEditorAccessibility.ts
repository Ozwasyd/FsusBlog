const FIRST_VISIBLE_FOCUSABLE = 'input:not([type="hidden"]):not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'

const VALIDATION_ERROR_FOCUS_SELECTOR = [
  '.write-validation-form [aria-invalid="true"]:not([disabled]):not([tabindex="-1"])',
  `.write-validation-form .el-form-item.is-error ${FIRST_VISIBLE_FOCUSABLE}`
].join(',')

function findFirstFocusable(root: ParentNode): HTMLElement | null {
  for (const selector of VALIDATION_ERROR_FOCUS_SELECTOR.split(',')) {
    const candidate = root.querySelector<HTMLElement>(selector.trim())
    if (candidate && !candidate.hidden && !candidate.closest('[aria-hidden="true"]')) {
      return candidate
    }
  }
  return null
}

export function focusFirstArticleValidationError(root: ParentNode = document): boolean {
  const target = findFirstFocusable(root)
  if (!target) {
    return false
  }

  target.focus({ preventScroll: true })
  target.scrollIntoView({ behavior: 'auto', block: 'center' })
  return true
}
