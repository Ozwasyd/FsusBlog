import { afterEach, describe, expect, it, vi } from 'vitest'

import { focusFirstArticleValidationError } from '@/components/admin/article/articleEditorAccessibility'

afterEach(() => {
  document.body.replaceChildren()
})

describe('article editor validation focus', () => {
  it('focuses the first enabled semantic invalid control without UI internals', () => {
    document.body.innerHTML = `
      <form class="write-validation-form">
        <input aria-invalid="false" />
        <input aria-invalid="true" disabled />
        <textarea aria-invalid="true"></textarea>
      </form>
    `
    const target = document.querySelector('textarea')!
    target.scrollIntoView = vi.fn()

    expect(focusFirstArticleValidationError()).toBe(true)
    expect(document.activeElement).toBe(target)
    expect(target.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'auto',
      block: 'center',
    })
  })

  it('does not move focus when no semantic invalid control exists', () => {
    document.body.innerHTML = `
      <form class="write-validation-form">
        <input aria-invalid="false" />
      </form>
    `

    expect(focusFirstArticleValidationError()).toBe(false)
  })
})
