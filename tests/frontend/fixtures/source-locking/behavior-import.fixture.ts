import { describe, expect, it } from 'vitest'
import { createAboutPageViewContract } from '@/view-contracts/aboutPage'

describe('behavior evidence', () => {
  it('executes the production contract', () => {
    const view = createAboutPageViewContract({ currentYear: 2026, content: '' })
    expect(view.header.currentYear).toBe(2026)
  })
})
