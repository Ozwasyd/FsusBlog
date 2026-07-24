const VALIDATION_ERROR_FOCUS_SELECTOR =
  '.write-validation-form [aria-invalid="true"]:not([disabled]):not([tabindex="-1"])'

export function focusFirstArticleValidationError(root: ParentNode = document): boolean {
  const target = root.querySelector<HTMLElement>(VALIDATION_ERROR_FOCUS_SELECTOR)
  if (!target) {
    return false
  }

  target.focus({ preventScroll: true })
  target.scrollIntoView({ behavior: 'auto', block: 'center' })
  return true
}
