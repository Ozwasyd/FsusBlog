import { describe, expect, it } from 'vitest'

import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT, NARROW_MOBILE_VIEWPORT } from '../../support/playwright/acceptance-shared'

describe('playwright acceptance shared helper', () => {
  it('loads shared viewport helpers through the frontend toolchain', () => {
    expect(DESKTOP_VIEWPORT).toEqual({ width: 1440, height: 960 })
    expect(MOBILE_VIEWPORT).toEqual({ width: 390, height: 844 })
    expect(NARROW_MOBILE_VIEWPORT).toEqual({ width: 360, height: 780 })
  })
})