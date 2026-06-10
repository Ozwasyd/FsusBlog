import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/components/admin/AdminTaskFeedbackBar.vue'),
  'utf8'
)

describe('AdminTaskFeedbackBar', () => {
  it('keeps polite and assertive live-region contracts in the template', () => {
    expect(source).toContain('role="status"')
    expect(source).toContain('aria-live="polite"')
    expect(source).toContain('role="alert"')
    expect(source).toContain('aria-live="assertive"')
    expect(source).toContain('data-admin-task-feedback="true"')
    expect(source).toContain('admin-task-feedback--${phase}')
    expect(source).toContain(':aria-busy="busy"')
  })
})
