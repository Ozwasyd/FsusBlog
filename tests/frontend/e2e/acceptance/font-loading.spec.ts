import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  waitForApplicationReady,
  waitForVisualFrameReady
} from '../../support/playwright/readiness.mjs'

const WARMUP_TIMEOUT_MS = 120_000

type FontLoadingSnapshot = Readonly<{
  ready: boolean
  loadedFamilies: readonly string[]
  errorFaces: readonly string[]
}>

const CONTENT_FONT = 'Noto Sans SC'
const UI_FONT = 'Google Sans'

async function readFontLoading(page: Page): Promise<FontLoadingSnapshot> {
  return await page.evaluate(async () => {
    await document.fonts.ready
    const faces = Array.from(document.fonts).map((face) => ({
      family: face.family,
      weight: face.weight,
      status: face.status
    }))
    return {
      ready: document.fonts.status === 'loaded',
      loadedFamilies: [...new Set(
        faces.filter((face) => face.status === 'loaded').map((face) => face.family)
      )],
      errorFaces: faces
        .filter((face) => face.status === 'error')
        .map((face) => `${face.weight} ${face.family}`)
    }
  })
}

async function expectFontLoaded(page: Page, family: string): Promise<void> {
  await expect.poll(
    async () => (await readFontLoading(page)).loadedFamilies.includes(family),
    {
      timeout: WARMUP_TIMEOUT_MS,
      message: `expected ${family} to have at least one loaded FontFace`
    }
  ).toBe(true)
}

test.describe('bundled font loading', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 })
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'Firefox/WebKit project the Chromium canonical product path'
  )

  test('default zh-CN home loads the content font without FontFace errors', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await waitForApplicationReady(page, { timeoutMs: WARMUP_TIMEOUT_MS })
    await waitForVisualFrameReady(page)

    await expectFontLoaded(page, CONTENT_FONT)
    const snapshot = await readFontLoading(page)
    expect(snapshot.ready).toBe(true)
    expect(snapshot.errorFaces).toEqual([])
  })

  test('switching to en-US loads the primary UI font without FontFace errors', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await waitForApplicationReady(page, { timeoutMs: WARMUP_TIMEOUT_MS })
    await waitForVisualFrameReady(page)

    const selector = page.locator('[data-locale-selector]').first()
    await page.locator('[data-locale-selector-trigger]').first().click()
    await page.locator('[data-locale-selector-item][data-locale-code="en-US"]').first().click()
    await expect(selector).toHaveAttribute('data-active-locale', 'en-US')
    await waitForVisualFrameReady(page)

    await expectFontLoaded(page, UI_FONT)
    const snapshot = await readFontLoading(page)
    expect(snapshot.errorFaces).toEqual([])
  })
})
