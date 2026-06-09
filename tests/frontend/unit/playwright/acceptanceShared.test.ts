import { describe, expect, it } from 'vitest'

import {
  DESKTOP_VIEWPORT,
  MOBILE_LANDSCAPE_VIEWPORT,
  MOBILE_VIEWPORT,
  NARROW_MOBILE_VIEWPORT,
  SHORT_MOBILE_VIEWPORT,
  ULTRA_WIDE_VIEWPORT,
  UX_CONTENT_BOUNDARY_CORPUS,
  UX_VIEWPORT_MATRIX
} from '../../support/playwright/acceptance-shared'

describe('playwright acceptance shared helper', () => {
  it('loads shared viewport helpers through the frontend toolchain', () => {
    expect(DESKTOP_VIEWPORT).toEqual({ width: 1440, height: 960 })
    expect(MOBILE_VIEWPORT).toEqual({ width: 390, height: 844 })
    expect(NARROW_MOBILE_VIEWPORT).toEqual({ width: 360, height: 780 })
    expect(SHORT_MOBILE_VIEWPORT).toEqual({ width: 390, height: 640 })
    expect(MOBILE_LANDSCAPE_VIEWPORT).toEqual({ width: 844, height: 390 })
    expect(ULTRA_WIDE_VIEWPORT).toEqual({ width: 3440, height: 1440 })
    expect(UX_VIEWPORT_MATRIX.modes.smoke.viewports).toContain('ultra-wide')
    expect(UX_CONTENT_BOUNDARY_CORPUS.cases.map((entry) => entry.kind)).toContain('mermaid')
  })
})
