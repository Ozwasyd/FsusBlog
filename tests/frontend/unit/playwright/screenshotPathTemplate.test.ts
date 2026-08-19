import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  playwrightLegacyScreenshotPathTemplate,
  playwrightScreenshotPathTemplate,
  resolvePlaywrightScreenshotPath
} from '../../support/playwright/screenshotPathTemplate.mjs'

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const configDir = path.join(repositoryRoot, 'src/frontend')
const testDir = path.join(repositoryRoot, 'tests/frontend/e2e')
const testFile = path.join(testDir, 'visual/public-visual.spec.ts')
const snapshotDir = path.join(testDir, 'visual')

const screenshotNames = [
  'public-home-desktop-light.png',
  'public-article-mobile-dark.png',
  'manage-dashboard-desktop-light.png',
  'admin-inline-empty-state-mobile.png'
]

function resolvePath(projectName: string, snapshotSuffix: string, name: string, pathTemplate?: string) {
  return resolvePlaywrightScreenshotPath({
    pathTemplate,
    projectName,
    snapshotSuffix,
    testFile,
    testDir,
    snapshotDir,
    configDir,
    name
  })
}

describe('Playwright screenshot path template', () => {
  it('keeps chromium-linux for chrome-branded and chromium-branded channels', () => {
    for (const name of screenshotNames) {
      const chromePath = resolvePath('chrome', 'linux', name)
      const chromiumPath = resolvePath('chromium', 'linux', name)

      expect(path.basename(chromePath)).toBe(name.replace(/\.png$/u, '-chromium-linux.png'))
      expect(path.basename(chromiumPath)).toBe(path.basename(chromePath))
      expect(chromePath).not.toContain('chrome-linux')
      expect(chromiumPath).not.toContain('chrome-linux')
      expect(chromePath.endsWith('-chromium-linux.png')).toBe(true)
    }
  })

  it('uses Playwright worker resolution rather than a reimplemented template', () => {
    const name = 'public-home-desktop-light.png'
    const legacyChrome = resolvePath('chrome', 'linux', name, playwrightLegacyScreenshotPathTemplate)
    const legacyChromium = resolvePath('chromium', 'linux', name, playwrightLegacyScreenshotPathTemplate)
    const pinnedChrome = resolvePath('chrome', 'linux', name, playwrightScreenshotPathTemplate)

    expect(path.basename(legacyChrome)).toBe('public-home-desktop-light-chrome-linux.png')
    expect(path.basename(legacyChromium)).toBe('public-home-desktop-light-chromium-linux.png')
    expect(path.basename(pinnedChrome)).toBe('public-home-desktop-light-chromium-linux.png')
    expect(legacyChrome).not.toBe(pinnedChrome)
  })
})
