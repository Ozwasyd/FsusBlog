import { describe, expect, it } from 'vitest'
import { shouldAssertManualResponsiveLayout } from '../../support/playwright/manualScreenshotRoutePlan'

describe('shouldAssertManualResponsiveLayout', () => {
  it('keeps ManageSecurityChallenges in the responsive layout contract', () => {
    expect(shouldAssertManualResponsiveLayout('ManageSecurityChallenges')).toBe(true)
    expect(shouldAssertManualResponsiveLayout('Home')).toBe(true)
    expect(shouldAssertManualResponsiveLayout('Search')).toBe(true)
  })

  it('does not exempt ManageSecurityChallenges with other overflowing manage tables', () => {
    expect(shouldAssertManualResponsiveLayout('ManageClusterRuntime')).toBe(false)
    expect(shouldAssertManualResponsiveLayout('ManageDashboard')).toBe(false)
  })
})
