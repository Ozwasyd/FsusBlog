const VALIDATION_ERROR_FOCUS_SELECTOR = [
  '.write-validation-form .el-form-item.is-error input:not([disabled])',
  '.write-validation-form .el-form-item.is-error textarea:not([disabled])',
  '.write-validation-form .el-form-item.is-error button:not([disabled])',
  '.write-validation-form .el-form-item.is-error [tabindex]:not([tabindex="-1"])'
].join(', ')

export function focusFirstArticleValidationError(root: ParentNode = document): boolean {
  const target = root.querySelector<HTMLElement>(VALIDATION_ERROR_FOCUS_SELECTOR)
  if (!target) {
    return false
  }

  target.focus({ preventScroll: true })
  target.scrollIntoView({ behavior: 'auto', block: 'center' })
  return true
}
